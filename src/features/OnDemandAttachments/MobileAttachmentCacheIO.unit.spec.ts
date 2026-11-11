import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { MobileAttachmentCacheIO, sha256Buffer } from "./MobileAttachmentCacheIO";

const base = "/storage/emulated/0/Documents/Synthetic Vault";
const path = "Archive/example.png";
const key = "a".repeat(64);
const stat = { type: "file" as const, size: 3, ctime: 100, mtime: 200 };
const recoveryRecord = (hash = "b".repeat(64)) => ({
    version: 1 as const,
    path,
    key,
    hash,
    stat,
    phase: "planned" as const,
});
async function harness() {
    let running = true;
    const files = new Map([[`${base}/${path}`, { ...stat }]]);
    const directories = new Set([base, `${base}/Archive`]);
    const contents = new Map<string, ArrayBuffer>();
    const fs = {
        stat: vi.fn(async (path: string) => {
            if (directories.has(path)) return { ...stat, type: "directory" as const, size: 0 };
            const found = files.get(path);
            if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return found;
        }),
        mkdir: vi.fn(async (path: string) => {
            if (directories.has(path)) throw new Error("Directory exists");
            directories.add(path);
        }),
        rename: vi.fn(async (from: string, to: string) => {
            const found = files.get(from);
            if (!found || files.has(to)) throw new Error("cannot replace");
            files.set(to, found);
            files.delete(from);
        }),
        readBinary: vi.fn(async (path: string) => contents.get(path) ?? new Uint8Array([1, 2, 3]).buffer),
        writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
            files.set(path, { ...stat, size: data.byteLength });
            contents.set(path, data);
        }),
        readdir: vi.fn(async (path: string) =>
            [...files.keys()]
                .filter((name) => name.startsWith(`${path}/`))
                .map((name) => ({ name: name.slice(path.length + 1), type: "file" as const }))
        ),
        setTimes: vi.fn(async (_path: string, _ctime: number, _mtime: number) => {}),
    };
    const adapter = {
        onFileChange: vi.fn((_path: unknown) => {}) as (path: unknown) => void,
        fs,
        getFullPath: vi.fn((path: string) => (path ? `${base}/${path}` : base)),
        queue: async <T>(task: () => Promise<T>) => await task(),
        reconcileFile: vi.fn(async () => {}),
        stat: async (path: string) => files.get(`${base}/${path}`) ?? null,
        readBinary: fs.readBinary,
    };
    const metadataCache = {
        fileCache: { [path]: { hash: "" } } as Record<string, unknown>,
        preload: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        db: {
            transaction: vi.fn(() => ({
                store: { delete: vi.fn(async (_path: string) => {}) },
                done: Promise.resolve(),
            })),
        },
    };
    const app = { vault: { adapter }, metadataCache } as unknown as App;
    return {
        io: await MobileAttachmentCacheIO.create(app, () => running),
        adapter,
        fs,
        files,
        contents,
        metadataCache,
        stop: () => {
            running = false;
        },
    };
}

describe("Android attachment cache IO", () => {
    it("keeps the native metadata snapshot beside the Vault without using its file queue", async () => {
        const f = await harness(),
            bytes = new Uint8Array([7, 8, 9]).buffer;
        f.adapter.queue = async () => {
            throw new Error("Vault queue must remain available");
        };
        await f.io.writeMetadataSnapshot(bytes);
        const [target] = f.fs.writeBinary.mock.calls[0];
        expect(target).not.toContain(`${base}/`);
        expect(target).toMatch(/\/metadata-startup-v1\.cache$/u);
        expect(await f.io.readMetadataSnapshot()).toEqual(bytes);
        expect(f.files.get(`${base}/${path}`)).toEqual(stat);
        expect(f.fs.rename).not.toHaveBeenCalled();
    });
    it("treats an absent metadata snapshot as optional and stops its IO after unload", async () => {
        const f = await harness();
        f.fs.readBinary.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
        expect(await f.io.readMetadataSnapshot()).toBeNull();
        f.stop();
        await expect(f.io.readMetadataSnapshot()).rejects.toThrow("stopped");
        await expect(f.io.writeMetadataSnapshot(new ArrayBuffer(0))).rejects.toThrow("stopped");
        expect(f.fs.writeBinary).not.toHaveBeenCalled();
    });
    it("writes independent recovery metadata while retaining the Vault queue for original moves", async () => {
        const f = await harness();
        f.adapter.queue = async () => {
            throw new Error("Vault queue unavailable");
        };
        await f.io.saveRecoveryRecord(recoveryRecord());
        await f.io.writeRegistryFingerprint(key);
        expect(await f.io.readRegistryFingerprint()).toBe(key);
        await expect(f.io.moveToCache(path, key)).rejects.toThrow("Vault queue unavailable");
        expect(f.files.has(`${base}/${path}`)).toBe(true);
        expect(f.fs.rename).not.toHaveBeenCalled();
    });
    it("serialises competing immutable recovery descriptions before either original can be replaced", async () => {
        const f = await harness();
        const first = f.io.saveRecoveryRecord(recoveryRecord());
        const second = f.io.saveRecoveryRecord(recoveryRecord("c".repeat(64)));
        await expect(first).resolves.toBeUndefined();
        await expect(second).rejects.toThrow("cannot replace");
        expect(f.fs.writeBinary).toHaveBeenCalledOnce();
        const saved = f.contents.get(f.fs.writeBinary.mock.calls[0][0]);
        expect(JSON.parse(new TextDecoder().decode(saved)).hash).toBe("b".repeat(64));
    });
    it("settles the active metadata write and rejects queued metadata after unload", async () => {
        const f = await harness(),
            originalWrite = f.fs.writeBinary.getMockImplementation()!;
        let release!: () => void, entered!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const writing = new Promise<void>((resolve) => {
            entered = resolve;
        });
        f.fs.writeBinary.mockImplementation(async (target, data) => {
            entered();
            await blocked;
            await originalWrite(target, data);
        });
        const first = f.io.writeRegistryFingerprint(key);
        await writing;
        const second = f.io.writeRegistryFingerprint("c".repeat(64));
        const rejected = expect(second).rejects.toThrow("stopped");
        let drained = false;
        const drain = f.io.waitForRecoveryMetadata().then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        f.stop();
        release();
        await first;
        await rejected;
        await drain;
        expect(drained).toBe(true);
        expect(f.fs.writeBinary).toHaveBeenCalledOnce();
        expect(await f.io.readRegistryFingerprint()).toBe(key);
    });
    it("keeps the metadata queue usable after a failed checkpoint write", async () => {
        const f = await harness();
        f.fs.writeBinary.mockRejectedValueOnce(new Error("storage unavailable"));
        await expect(f.io.writeRegistryFingerprint(key)).rejects.toThrow("storage unavailable");
        await f.io.writeRegistryFingerprint("c".repeat(64));
        expect(await f.io.readRegistryFingerprint()).toBe("c".repeat(64));
    });
    it("commits derived-cache removal before moving an original", async () => {
        const f = await harness();
        f.fs.rename.mockImplementation(async (from, to) => {
            expect(f.metadataCache.fileCache[path]).toBeUndefined();
            expect(f.metadataCache.db.transaction).toHaveBeenCalledExactlyOnceWith("file", "readwrite");
            const found = f.files.get(from);
            if (!found || f.files.has(to)) throw new Error("cannot replace");
            f.files.set(to, found);
            f.files.delete(from);
        });
        await f.io.moveToCache(path, key);
        expect(f.fs.rename).toHaveBeenCalledOnce();
    });
    it("keeps the original resident if the derived-cache transaction fails", async () => {
        const f = await harness();
        f.metadataCache.db.transaction.mockImplementation(() => {
            throw new Error("database unavailable");
        });
        await expect(f.io.moveToCache(path, key)).rejects.toThrow("database unavailable");
        expect(f.fs.rename).not.toHaveBeenCalled();
        expect(f.files.has(`${base}/${path}`)).toBe(true);
        expect(f.metadataCache.fileCache[path]).toBeDefined();
    });
    it("defers only events for retired originals while forwarding live note changes", async () => {
        const f = await harness(),
            original = vi.fn((_path: unknown) => {});
        f.adapter.onFileChange = original;
        const retired = new Set([path]);
        const lease = f.io.deferRetiredFileEvents((p) => retired.has(p));
        expect(f.io.deferRetiredFileEvents(() => false)).toBe(lease);
        const restore = await lease;
        f.adapter.onFileChange(path);
        f.adapter.onFileChange("/" + path);
        expect(original).not.toHaveBeenCalled();
        f.adapter.onFileChange("notes/live.md");
        expect(original).toHaveBeenCalledExactlyOnceWith("notes/live.md");
        expect(original.mock.contexts[0]).toBe(f.adapter);
        retired.delete(path);
        f.adapter.onFileChange(path);
        expect(original).toHaveBeenLastCalledWith(path);
        restore();
        expect(f.adapter.onFileChange).toBe(original);
    });
    it("restores event delivery after a failed original operation", async () => {
        const f = await harness(),
            original = f.adapter.onFileChange;
        const restore = await f.io.deferRetiredFileEvents(() => true);
        try {
            await f.io.moveToCache("../invalid.png", key);
        } catch {
            /* The source remains resident. */
        } finally {
            restore();
        }
        expect(f.adapter.onFileChange).toBe(original);
        expect(f.files.has(base + "/" + path)).toBe(true);
    });
    it("disables its filter without replacing a later event owner", async () => {
        const f = await harness(),
            original = vi.fn((_path: unknown) => {});
        f.adapter.onFileChange = original;
        const restore = await f.io.deferRetiredFileEvents(() => true);
        const filtered = f.adapter.onFileChange,
            other = vi.fn((p: unknown) => filtered(p));
        f.adapter.onFileChange = other;
        restore();
        f.adapter.onFileChange(path);
        expect(f.adapter.onFileChange).toBe(other);
        expect(original).toHaveBeenCalledExactlyOnceWith(path);
    });
    it("makes cleanup idempotent across consecutive batches", async () => {
        const f = await harness();
        const first = await f.io.deferRetiredFileEvents(() => true);
        first();
        const next = f.io.deferRetiredFileEvents(() => false);
        const second = await next;
        first();
        expect(f.io.deferRetiredFileEvents(() => true)).toBe(next);
        second();
    });
    it("forwards unknown native event values without treating them as retired paths", async () => {
        const f = await harness(),
            original = vi.fn((_path: unknown) => {});
        f.adapter.onFileChange = original;
        const restore = await f.io.deferRetiredFileEvents(() => true);
        f.adapter.onFileChange(null);
        f.adapter.onFileChange(undefined);
        expect(original.mock.calls).toEqual([[null], [undefined]]);
        restore();
    });
    it("does not alter event ownership after unload or without a supported handler", async () => {
        const f = await harness(),
            original = f.adapter.onFileChange;
        f.stop();
        await expect(f.io.deferRetiredFileEvents(() => true)).rejects.toThrow("stopped");
        expect(f.adapter.onFileChange).toBe(original);
        const g = await harness();
        Reflect.set(g.adapter, "onFileChange", undefined);
        await expect(g.io.deferRetiredFileEvents(() => true)).rejects.toThrow("handler is unavailable");
        expect(g.fs.rename).not.toHaveBeenCalled();
    });
    it("retires a consumed original before a later legitimate source rename or deletion", async () => {
        const f = await harness();
        const record = {
            version: 1 as const,
            path,
            key,
            hash: await sha256Buffer(new Uint8Array([1, 2, 3]).buffer),
            stat,
            phase: "restoring" as const,
        };
        await f.io.archiveRecoveryRecord(record);
        f.files.delete(`${base}/${path}`);
        expect(await f.io.recoveryRecords()).toEqual([]);
    });
    it("keeps unconsumed originals recoverable even when a source file already exists", async () => {
        const f = await harness();
        await f.io.writeCache(key, new Uint8Array([1, 2, 3]).buffer);
        const record = {
            version: 1 as const,
            path,
            key,
            hash: await sha256Buffer(new Uint8Array([1, 2, 3]).buffer),
            stat,
            phase: "cached" as const,
        };
        await f.io.archiveRecoveryRecord(record);
        expect(await f.io.recoveryRecords()).toEqual([record]);
    });
    it("moves the original outside the Vault, restores exact timestamps, and reconciles only the logical path", async () => {
        const f = await harness();
        await f.io.moveToCache(path, key);
        expect(f.adapter.reconcileFile).not.toHaveBeenCalled();
        const target = f.fs.rename.mock.calls[0][1];
        expect(target.startsWith(`${base}/`)).toBe(false);
        expect(target).toMatch(/\/\.livesync-attachment-cache\/[a-f0-9]{64}\/aa\/[a-f0-9]{64}\.bin$/u);
        expect(await f.io.sourceStat(path)).toBeNull();
        await f.io.moveToVault(key, path, stat);
        expect(f.fs.mkdir).not.toHaveBeenCalledWith(`${base}/Archive`);
        expect(f.fs.setTimes).toHaveBeenCalledWith(`${base}/${path}`, stat.ctime, stat.mtime);
        expect(f.adapter.reconcileFile).toHaveBeenCalledWith(path, path, true);
        expect(f.files.has(`${base}/${path}`)).toBe(true);
    });
    it("checks native presence when the host still reports a retired file", async () => {
        const f = await harness();
        f.adapter.stat = async () => stat;
        await f.io.moveToCache(path, key);
        expect(await f.io.sourceStat(path)).toBeNull();
        expect(await f.io.cacheStat(key)).toEqual({ size: 3, ctime: 100, mtime: 200 });
    });
    it("refuses unsafe logical paths and cache keys before native IO", async () => {
        const f = await harness();
        await expect(f.io.moveToCache("../outside.png", key)).rejects.toThrow("Unsafe");
        await expect(f.io.cacheRead("../../outside")).rejects.toThrow("Unsafe");
        f.adapter.getFullPath.mockReturnValue("/storage/emulated/0/outside.png");
        await expect(f.io.sourceRead(path)).rejects.toThrow("leaves");
        expect(f.fs.rename).not.toHaveBeenCalled();
        expect(f.fs.readBinary).not.toHaveBeenCalled();
    });
    it("does not replace a concurrently restored source", async () => {
        const f = await harness();
        await f.io.moveToCache(path, key);
        f.files.set(`${base}/${path}`, { ...stat, size: 99 });
        await expect(f.io.moveToVault(key, path, stat)).rejects.toThrow("cannot replace");
        expect(f.files.get(`${base}/${path}`)?.size).toBe(99);
        expect(await f.io.cacheStat(key)).not.toBeNull();
    });
    it("checks unload again after queued directory work before moving or writing", async () => {
        const f = await harness();
        f.fs.mkdir.mockImplementation(async () => {
            f.stop();
        });
        await expect(f.io.moveToCache(path, key)).rejects.toThrow("stopped");
        expect(f.fs.rename).not.toHaveBeenCalled();
        expect(f.files.has(`${base}/${path}`)).toBe(true);
        const g = await harness();
        g.fs.mkdir.mockImplementation(async () => {
            g.stop();
        });
        await expect(g.io.writeCache(key, new ArrayBuffer(3))).rejects.toThrow("stopped");
        expect(g.fs.writeBinary).not.toHaveBeenCalled();
    });
    it("does not interpret a permission or IO failure as a missing original", async () => {
        const f = await harness();
        f.fs.stat.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
        await expect(f.io.cacheStat(key)).rejects.toThrow("denied");
    });
    it("preserves independent path metadata and detects corrupt checkpoint writes", async () => {
        const f = await harness();
        const record = { version: 1 as const, path, key, hash: "b".repeat(64), stat, phase: "planned" as const };
        await f.io.saveRecoveryRecord(record);
        await f.io.saveRecoveryRecord({ ...record, phase: "cached" });
        expect(f.fs.writeBinary).toHaveBeenCalledTimes(1);
        expect(await f.io.recoveryRecords()).toEqual([record]);
        await expect(f.io.saveRecoveryRecord({ ...record, hash: "c".repeat(64) })).rejects.toThrow("cannot replace");
        await f.io.writeRegistryFingerprint(key);
        expect(await f.io.readRegistryFingerprint()).toBe(key);
        f.fs.writeBinary.mockImplementation(async () => {});
        await expect(f.io.writeRegistryFingerprint("c".repeat(64))).rejects.toThrow("write failed");
    });
});
