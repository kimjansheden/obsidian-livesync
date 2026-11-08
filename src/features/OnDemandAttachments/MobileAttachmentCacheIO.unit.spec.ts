import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { MobileAttachmentCacheIO, sha256Buffer } from "./MobileAttachmentCacheIO";

const base = "/storage/emulated/0/Documents/Synthetic Vault";
const path = "Archive/example.png";
const key = "a".repeat(64);
const stat = { type: "file" as const, size: 3, ctime: 100, mtime: 200 };
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
        fs,
        getFullPath: vi.fn((path: string) => (path ? `${base}/${path}` : base)),
        queue: async <T>(task: () => Promise<T>) => await task(),
        reconcileFile: vi.fn(async () => {}),
        stat: async (path: string) => files.get(`${base}/${path}`) ?? null,
        readBinary: fs.readBinary,
    };
    const app = { vault: { adapter } } as unknown as App;
    return {
        io: await MobileAttachmentCacheIO.create(app, () => running),
        adapter,
        fs,
        files,
        contents,
        stop: () => {
            running = false;
        },
    };
}

describe("Android attachment cache IO", () => {
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
