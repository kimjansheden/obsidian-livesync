import { describe, expect, it, vi } from "vitest";
import type { DataAdapter, Stat } from "obsidian";
import { StagedBinaryPublication } from "./stagedBinaryPublication";

const target = "attachment.bin";
function fixture() {
    const files = new Map<string, { bytes: number[]; mtime: number; ctime: number }>();
    const directories = new Set<string>();
    let clock = 10;
    let tail: Promise<unknown> = Promise.resolve();
    const queue = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = tail.then(operation, operation);
        tail = next;
        return next;
    };
    const stat = (path: string): Stat | null => {
        const file = files.get(path);
        if (file) return { type: "file", size: file.bytes.length, mtime: file.mtime, ctime: file.ctime };
        if (directories.has(path)) return { type: "folder", size: 0, mtime: 1, ctime: 1 };
        return null;
    };
    const rename = vi.fn(async (from: string, to: string) => {
        files.delete(to);
        files.set(to, files.get(from)!);
        files.delete(from);
    });
    const adapter = {
        queue,
        getFullPath: (path: string) => path,
        fs: {
            rename,
            stat: vi.fn(async (path: string) => {
                const result = stat(path);
                if (!result) throw Object.assign(new Error("absent"), { code: "ENOENT" });
                return { ...result, type: result.type === "folder" ? "directory" : "file" };
            }),
        },
        stat: vi.fn(async (path: string) => queue(async () => stat(path))),
        mkdir: vi.fn(async (path: string) => {
            directories.add(path);
        }),
        list: vi.fn(async (root: string) => ({
            files: [...files.keys()].filter((p) => p.startsWith(root + "/")),
            folders: [],
        })),
        remove: vi.fn(async (path: string) => {
            files.delete(path);
        }),
        writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
            files.set(path, { bytes: [...new Uint8Array(data)], mtime: ++clock, ctime: 1 });
        }),
        appendBinary: vi.fn(async (path: string, data: ArrayBuffer, options?: { mtime?: number; ctime?: number }) => {
            const file = files.get(path)!;
            file.bytes.push(...new Uint8Array(data));
            file.mtime = options?.mtime ?? ++clock;
            file.ctime = options?.ctime ?? file.ctime;
        }),
        reconcileInternalFile: vi.fn(async () => {}),
    };
    files.set(target, { bytes: [9, 9, 9], mtime: 5, ctime: 1 });
    const expectedTarget = stat(target)!;
    const beforePublish = vi.fn(async () => {});
    const publication = { expectedTarget, size: 6, beforePublish, afterPublish: vi.fn(async (_stat: Stat) => {}) };
    return {
        files,
        directories,
        adapter,
        stat,
        rename,
        publication,
        beforePublish,
        writer: new StagedBinaryPublication(adapter as unknown as DataAdapter),
    };
}
async function* content() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3, 4, 5, 6]);
}

describe("staged binary publication", () => {
    it("keeps the old target through every part and publishes exactly one complete file", async () => {
        const f = fixture();
        async function* checked() {
            for await (const part of content()) {
                expect(f.files.get(target)?.bytes).toEqual([9, 9, 9]);
                yield part;
            }
        }
        expect(await f.writer.write(target, checked(), f.publication, { mtime: 20, ctime: 1 })).toBe(true);
        expect(f.files.get(target)).toEqual({ bytes: [1, 2, 3, 4, 5, 6], mtime: 20, ctime: 1 });
        expect(f.beforePublish.mock.invocationCallOrder[0]).toBeLessThan(f.rename.mock.invocationCallOrder[0]);
        expect(f.adapter.writeBinary.mock.calls.every(([p]) => p.startsWith(".trash/.livesync-staging/"))).toBe(true);
        expect([...f.files.keys()]).toEqual([target]);
    });
    it("leaves the old target intact on failure halfway through staging", async () => {
        const f = fixture();
        async function* broken() {
            yield new Uint8Array([1, 2]);
            throw new Error("source unavailable");
        }
        await expect(f.writer.write(target, broken(), f.publication)).rejects.toThrow("source unavailable");
        expect(f.files.get(target)?.bytes).toEqual([9, 9, 9]);
        expect(f.beforePublish).not.toHaveBeenCalled();
        expect(f.rename).not.toHaveBeenCalled();
    });
    it("does not touch the target if persisting the publication mark fails", async () => {
        const f = fixture();
        f.beforePublish.mockRejectedValue(new Error("journal unavailable"));
        await expect(f.writer.write(target, content(), f.publication)).rejects.toThrow("journal unavailable");
        expect(f.files.get(target)?.bytes).toEqual([9, 9, 9]);
        expect(f.rename).not.toHaveBeenCalled();
    });
    it("keeps the old target after interruption between the durable mark and native rename", async () => {
        const f = fixture();
        f.rename.mockRejectedValue(new Error("interrupted before rename"));
        await expect(f.writer.write(target, content(), f.publication)).rejects.toThrow("interrupted before rename");
        expect(f.beforePublish).toHaveBeenCalledOnce();
        expect(f.files.get(target)?.bytes).toEqual([9, 9, 9]);
    });
    it("leaves only a protected absence if Android fails after predelete", async () => {
        const f = fixture();
        f.rename.mockImplementation(async (_from, to) => {
            f.files.delete(to);
            throw new Error("interrupted after predelete");
        });
        await expect(f.writer.write(target, content(), f.publication)).rejects.toThrow("interrupted after predelete");
        expect(f.beforePublish).toHaveBeenCalledOnce();
        expect(f.files.has(target)).toBe(false);
    });
    it("keeps a complete new target when index reconciliation fails after rename", async () => {
        const f = fixture();
        f.adapter.reconcileInternalFile.mockRejectedValue(new Error("index unavailable"));
        await expect(f.writer.write(target, content(), f.publication)).rejects.toThrow("index unavailable");
        expect(f.files.get(target)?.bytes).toEqual([1, 2, 3, 4, 5, 6]);
        expect(f.beforePublish).toHaveBeenCalledOnce();
    });
    it("preserves a local target change made during staging", async () => {
        const f = fixture();
        async function* changed() {
            yield new Uint8Array([1, 2]);
            f.files.set(target, { bytes: [7, 7, 7, 7], mtime: 30, ctime: 1 });
            yield new Uint8Array([3, 4, 5, 6]);
        }
        expect(await f.writer.write(target, changed(), f.publication)).toBe(false);
        expect(f.files.get(target)?.bytes).toEqual([7, 7, 7, 7]);
        expect(f.beforePublish).not.toHaveBeenCalled();
    });
    it("does not replace a directory or treat an unreadable native stat as absence", async () => {
        const f = fixture();
        f.files.delete(target);
        f.directories.add(target);
        expect(await f.writer.write(target, content(), f.publication)).toBe(false);
        f.adapter.fs.stat.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
        await expect(f.writer.write(target, content(), { ...f.publication, expectedTarget: null })).rejects.toThrow(
            "denied"
        );
        expect(f.rename).not.toHaveBeenCalled();
        expect(f.beforePublish).not.toHaveBeenCalled();
    });
    it("rejects truncated and oversized source content before publication", async () => {
        const f = fixture();
        for (const size of [5, 7])
            await expect(f.writer.write(target, content(), { ...f.publication, size })).rejects.toThrow();
        expect(f.files.get(target)?.bytes).toEqual([9, 9, 9]);
        expect(f.rename).not.toHaveBeenCalled();
    });
    it("records the published stat inside the queue before a later same-size local edit", async () => {
        const f = fixture();
        f.adapter.reconcileInternalFile.mockImplementation(async () => {
            f.files.set(target, { bytes: [7, 7, 7, 7, 7, 7], mtime: 30, ctime: 1 });
        });
        expect(await f.writer.write(target, content(), f.publication, { mtime: 20, ctime: 1 })).toBe(true);
        expect(f.publication.afterPublish).toHaveBeenCalledWith({ type: "file", size: 6, mtime: 20, ctime: 1 });
        expect(f.files.get(target)?.mtime).toBe(30);
    });
    it("keeps a complete target if completing provenance fails after native rename", async () => {
        const f = fixture();
        f.publication.afterPublish.mockRejectedValue(new Error("journal finish failed"));
        await expect(f.writer.write(target, content(), f.publication)).rejects.toThrow("journal finish failed");
        expect(f.files.get(target)?.bytes).toEqual([1, 2, 3, 4, 5, 6]);
        expect(f.beforePublish).toHaveBeenCalledOnce();
    });
    it("cleans only its recognised leftovers before new stages begin", async () => {
        const f = fixture();
        const root = ".trash/.livesync-staging/";
        const stale = root + "00000000-0000-0000-0000-000000000000.stage";
        const user = root + "keep-me.bin";
        for (const p of [stale, user, ".trash/unrelated.bin"]) f.files.set(p, { bytes: [8], mtime: 1, ctime: 1 });
        expect(await f.writer.write(target, content(), f.publication)).toBe(true);
        expect(f.files.has(stale)).toBe(false);
        expect(f.files.has(user)).toBe(true);
        expect(f.files.has(".trash/unrelated.bin")).toBe(true);
    });
});
