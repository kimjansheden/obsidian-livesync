import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
    AttachmentCache,
    ATTACHMENT_AGE_MS,
    MAX_CACHED_ATTACHMENT_BYTES,
    canCacheAttachment,
    validAttachmentPath,
    type AttachmentCacheDependencies,
    type AttachmentCacheRecord,
    type AttachmentStat,
} from "./AttachmentCache";

const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer;
const hash = async (data: ArrayBuffer) => createHash("sha256").update(new Uint8Array(data)).digest("hex");
const path = "Archive/images/example.svg";
const original = bytes("<svg>synthetic original</svg>");
const now = 2_000_000_000_000;
const stat = { size: original.byteLength, mtime: now - ATTACHMENT_AGE_MS - 1, ctime: now - ATTACHMENT_AGE_MS - 2 };

async function harness() {
    const source = new Map<string, { data: ArrayBuffer; stat: AttachmentStat }>([
        [path, { data: original.slice(0), stat }],
    ]);
    const cached = new Map<string, ArrayBuffer>();
    const records = new Map<string, AttachmentCacheRecord>();
    const history: AttachmentCacheRecord[] = [];
    let sequence = 0;
    const deps: AttachmentCacheDependencies = {
        store: {
            keys: vi.fn(async () => [...records.keys()]),
            get: vi.fn(async (key) => structuredClone(records.get(key))),
            set: vi.fn(async (key, value) => {
                records.set(key, structuredClone(value));
            }),
            delete: vi.fn(async (key) => {
                records.delete(key);
            }),
            archive: vi.fn(async (record) => {
                history.push(structuredClone(record));
            }),
        },
        io: {
            sourceStat: vi.fn(async (key) => source.get(key)?.stat ?? null),
            sourceRead: vi.fn(async (key) => {
                const value = source.get(key);
                if (!value) throw Error("missing source");
                return value.data.slice(0);
            }),
            cacheStat: vi.fn(async (key) => (cached.has(key) ? { ...stat, size: cached.get(key)!.byteLength } : null)),
            cacheRead: vi.fn(async (key) => {
                const value = cached.get(key);
                if (!value) throw Error("missing cache");
                return value.slice(0);
            }),
            moveToCache: vi.fn(async (key, target) => {
                const value = source.get(key);
                if (!value || cached.has(target)) throw Error("cannot move");
                cached.set(target, value.data);
                source.delete(key);
            }),
            moveToVault: vi.fn(async (key, target, restoredStat) => {
                const value = cached.get(key);
                if (!value || source.has(target)) throw Error("cannot overwrite");
                source.set(target, { data: value, stat: restoredStat });
                cached.delete(key);
            }),
            writeCache: vi.fn(async (key, data) => {
                if (cached.has(key)) throw Error("cannot overwrite");
                cached.set(key, data);
            }),
        },
        hash,
        newKey: () => (++sequence).toString(16).padStart(64, "0"),
        withPathLock: async (_path, task) => await task(),
        revision: vi.fn(async () => "1-synthetic"),
        recover: vi.fn(async () => false as const),
        afterRestore: vi.fn(async () => {}),
        mayRun: () => true,
        now: () => now,
    };
    const cache = new AttachmentCache(deps);
    await cache.load();
    return { cache, deps, source, cached, records, history };
}

describe("device-local attachment materialisation", () => {
    it("keeps exact original bytes outside the Vault and restores them after a restart without a network request", async () => {
        const h = await harness();
        expect(await h.cache.dehydrate(path)).toBe(true);
        expect(h.source.has(path)).toBe(false);
        expect(h.cached.size).toBe(1);
        expect(h.cache.isDeferred(path)).toBe(true);
        const restarted = new AttachmentCache(h.deps);
        await restarted.load();
        expect(await restarted.hydrate(path)).toBe(true);
        expect(h.source.get(path)).toEqual({ data: original, stat });
        expect(h.cached.size).toBe(0);
        expect(restarted.isDeferred(path)).toBe(false);
        expect(h.deps.recover).not.toHaveBeenCalled();
        expect(h.deps.afterRestore).toHaveBeenCalledOnce();
    });

    it("loads only the selection index during startup", async () => {
        const h = await harness();
        await h.cache.dehydrate(path);
        vi.mocked(h.deps.store.get).mockClear();
        vi.mocked(h.deps.io.cacheRead).mockClear();
        const restarted = new AttachmentCache(h.deps);
        await restarted.load();
        expect(restarted.paths).toEqual([path]);
        expect(h.deps.store.get).not.toHaveBeenCalled();
        expect(h.deps.io.cacheRead).not.toHaveBeenCalled();
    });

    it.each(["before-move", "after-move", "after-restore"])(
        "recovers interruption at %s without losing either copy",
        async (stage) => {
            const h = await harness();
            if (stage === "before-move") vi.mocked(h.deps.io.moveToCache).mockRejectedValueOnce(Error("interrupted"));
            if (stage === "after-move")
                vi.mocked(h.deps.store.set)
                    .mockImplementationOnce(async (key, value) => {
                        h.records.set(key, value);
                    })
                    .mockRejectedValueOnce(Error("interrupted"));
            if (stage === "after-restore") {
                await h.cache.dehydrate(path);
                vi.mocked(h.deps.store.archive).mockRejectedValueOnce(Error("interrupted"));
                await expect(h.cache.hydrate(path)).rejects.toThrow("interrupted");
            } else await expect(h.cache.dehydrate(path)).rejects.toThrow("interrupted");
            expect(h.records.has(path)).toBe(true);
            const restarted = new AttachmentCache(h.deps);
            await restarted.load();
            expect(await restarted.hydrate(path)).toBe(true);
            expect(h.source.get(path)?.data).toEqual(original);
        }
    );

    it("refuses corrupt cached bytes and preserves the recovery record", async () => {
        const h = await harness();
        await h.cache.dehydrate(path);
        const key = h.records.get(path)!.key;
        h.cached.set(key, bytes("corrupt"));
        await expect(h.cache.hydrate(path)).rejects.toThrow("does not match");
        expect(h.records.has(path)).toBe(true);
        expect(h.source.has(path)).toBe(false);
        expect(h.cached.get(key)).toEqual(bytes("corrupt"));
    });

    it("uses a synced recovery copy only when its size and SHA-256 match the original", async () => {
        const h = await harness();
        await h.cache.dehydrate(path);
        h.cached.clear();
        vi.mocked(h.deps.recover).mockResolvedValueOnce(bytes("another revision"));
        await expect(h.cache.hydrate(path)).rejects.toThrow("does not match");
        expect(h.source.has(path)).toBe(false);
        vi.mocked(h.deps.recover).mockResolvedValueOnce(original);
        expect(await h.cache.hydrate(path)).toBe(true);
        expect(h.source.get(path)?.data).toEqual(original);
    });

    it("never replaces a concurrently created local file and retains the older cached original", async () => {
        const h = await harness();
        await h.cache.dehydrate(path);
        const replacement = bytes("independent local edit");
        h.source.set(path, { data: replacement, stat: { ...stat, size: replacement.byteLength } });
        expect(await h.cache.hydrate(path)).toBe(true);
        expect(h.source.get(path)?.data).toEqual(replacement);
        expect([...h.cached.values()]).toEqual([original]);
        expect(h.history).toHaveLength(1);
        expect(h.deps.io.moveToVault).not.toHaveBeenCalled();
    });

    it("coalesces simultaneous demand for the same attachment", async () => {
        const h = await harness();
        await h.cache.dehydrate(path);
        const first = h.cache.hydrate(path),
            second = h.cache.hydrate(path);
        expect(first).toBe(second);
        expect(await first).toBe(true);
        expect(h.deps.io.moveToVault).toHaveBeenCalledOnce();
    });

    it("does not move a file which changed while it was read", async () => {
        const h = await harness();
        vi.mocked(h.deps.io.sourceStat)
            .mockResolvedValueOnce(stat)
            .mockResolvedValueOnce({ ...stat, mtime: stat.mtime + 1 });
        expect(await h.cache.dehydrate(path)).toBe(false);
        expect(h.source.get(path)?.data).toEqual(original);
        expect(h.records.size).toBe(0);
    });

    it("stops before moving when the host unloads", async () => {
        const h = await harness();
        let active = true;
        h.deps.mayRun = () => active;
        vi.mocked(h.deps.revision).mockImplementation(async () => {
            active = false;
            return undefined;
        });
        await expect(h.cache.dehydrate(path)).rejects.toThrow("unavailable");
        expect(h.source.get(path)?.data).toEqual(original);
        expect(h.deps.io.moveToCache).not.toHaveBeenCalled();
    });
    it("keeps offline or unpublished bytes resident when their exact recovery revision cannot be proved", async () => {
        const h = await harness();
        vi.mocked(h.deps.revision).mockResolvedValue(undefined);
        expect(await h.cache.dehydrate(path)).toBe(false);
        expect(h.source.get(path)?.data).toEqual(original);
        expect(h.records.size).toBe(0);
        expect(h.deps.io.moveToCache).not.toHaveBeenCalled();
        expect(h.deps.revision).toHaveBeenCalledWith(path, await hash(original), stat);
    });

    it("keeps notes, recent files and large streamed files resident; rejects unsafe paths", () => {
        for (const bad of [
            "note.md",
            "png",
            "/Archive/a.svg",
            "../a.svg",
            ".obsidian/a.svg",
            "Archive/.hidden/a.png",
            "Archive/../a.svg",
            "Archive/a.png:stream",
            "Archive\\a.svg",
        ])
            expect(validAttachmentPath(bad)).toBe(false);
        expect(canCacheAttachment(path, { ...stat, size: MAX_CACHED_ATTACHMENT_BYTES + 1 }, now)).toBe(false);
        expect(canCacheAttachment(path, { ...stat, mtime: now }, now)).toBe(false);
        expect(canCacheAttachment(path, stat, now)).toBe(true);
    });
});
