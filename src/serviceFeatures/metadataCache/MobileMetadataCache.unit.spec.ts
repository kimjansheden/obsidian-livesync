import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { MobileMetadataCache } from "./MobileMetadataCache";

function fixture(count = 3) {
    const note = { hash: "synthetic-note-hash", mtime: 100, size: 12 };
    const fileCache: Record<string, unknown> = { "Notes/resident.md": note };
    for (let index = 0; index < count; index++) fileCache[`Retired/item-${index}.png`] = { hash: "" };
    const persisted = new Map(Object.entries(fileCache));
    const parsedMetadata = { [note.hash]: { headings: [{ heading: "Synthetic note" }] } };
    let failCommit = false,
        finishCommit: (() => Promise<void>) | undefined;
    const transactions: string[][] = [];
    const host = {
        fileCache,
        metadataCache: parsedMetadata,
        preload: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        db: {
            transaction: vi.fn((store: string, mode: string) => {
                expect(store).toBe("file");
                expect(mode).toBe("readwrite");
                const staged: string[] = [];
                transactions.push(staged);
                const done = Promise.resolve().then(async () => {
                    await finishCommit?.();
                    if (failCommit) throw new Error("commit failed");
                    for (const path of staged) persisted.delete(path);
                });
                return {
                    store: {
                        delete: async (path: string) => {
                            staged.push(path);
                        },
                    },
                    done,
                };
            }),
        },
    };
    const resident = vi.fn((path: string) => (path === "Notes/resident.md" ? { path } : null));
    const app = { metadataCache: host, vault: { getFileByPath: resident } } as unknown as App;
    return {
        pruner: new MobileMetadataCache(app),
        app,
        host,
        persisted,
        transactions,
        resident,
        note,
        parsedMetadata,
        fail: () => {
            failCommit = true;
        },
        delayCommit: (finish: () => Promise<void>) => {
            finishCommit = finish;
        },
    };
}

describe("Android derived file cache", () => {
    it("keeps cache ownership bound to its Vault when the app switches Vaults", async () => {
        const original = fixture(),
            next = fixture();
        Reflect.set(original.app, "metadataCache", next.host);
        Reflect.set(original.app, "vault", { getFileByPath: () => null });
        expect(await original.pruner.pruneMissing()).toBe(3);
        expect(original.persisted.size).toBe(1);
        expect(original.host.fileCache["Notes/resident.md"]).toBe(original.note);
        expect(next.persisted.size).toBe(4);
        expect(next.transactions).toHaveLength(0);
    });
    it("retires an absent note index without discarding shared parsed metadata or a resident note", async () => {
        const f = fixture();
        f.host.fileCache["Moved/previous-name.md"] = f.note;
        f.persisted.set("Moved/previous-name.md", f.note);
        expect(await f.pruner.pruneMissing()).toBe(4);
        expect(f.persisted.has("Moved/previous-name.md")).toBe(false);
        expect(f.host.fileCache["Notes/resident.md"]).toBe(f.note);
        expect(f.host.metadataCache[f.note.hash]).toBe(f.parsedMetadata[f.note.hash]);
    });
    it("removes missing index entries while preserving resident notes and their parsed metadata", async () => {
        const f = fixture();
        const originalMetadata = JSON.stringify({ note: f.note, parsed: f.parsedMetadata });
        expect(await f.pruner.pruneMissing()).toBe(3);
        expect(f.host.fileCache).toEqual({ "Notes/resident.md": f.note });
        expect([...f.persisted.keys()]).toEqual(["Notes/resident.md"]);
        expect(f.host.fileCache["Notes/resident.md"]).toBe(f.note);
        expect(f.host.metadataCache).toBe(f.parsedMetadata);
        expect(JSON.stringify({ note: f.host.fileCache["Notes/resident.md"], parsed: f.host.metadataCache })).toBe(
            originalMetadata
        );
        expect(f.host.preload).toHaveBeenCalledOnce();
    });

    it("bounds each transaction while pruning a large stale index", async () => {
        const f = fixture(2049);
        expect(await f.pruner.pruneMissing()).toBe(2049);
        expect(f.transactions.length).toBeGreaterThan(1);
        expect(f.transactions.flat()).toHaveLength(2049);
        expect(f.transactions.every((batch) => batch.length < 2049)).toBe(true);
        expect(f.persisted.size).toBe(1);
    });

    it("does not discard the in-memory index before its database transaction commits", async () => {
        const f = fixture(1);
        let finish: (() => void) | undefined;
        f.delayCommit(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        const deleting = f.pruner.forget(["Retired/item-0.png"]);
        await vi.waitFor(() => expect(finish).toBeDefined());
        expect(f.host.fileCache["Retired/item-0.png"]).toBeDefined();
        expect(f.persisted.has("Retired/item-0.png")).toBe(true);
        finish?.();
        await deleting;
        expect(f.host.fileCache["Retired/item-0.png"]).toBeUndefined();
        expect(f.persisted.has("Retired/item-0.png")).toBe(false);
    });

    it("preserves both cache views if a transaction fails", async () => {
        const f = fixture(1);
        f.fail();
        await expect(f.pruner.pruneMissing()).rejects.toThrow("commit failed");
        expect(f.host.fileCache["Retired/item-0.png"]).toBeDefined();
        expect(f.persisted.has("Retired/item-0.png")).toBe(true);
    });

    it("prunes before the host can initialise its link index", async () => {
        const f = fixture();
        const cleanup: (() => void)[] = [],
            failure = vi.fn();
        f.host.initialize.mockImplementation(async () => {
            expect(Object.keys(f.host.fileCache)).toEqual(["Notes/resident.md"]);
        });
        f.pruner.install((fn) => cleanup.push(fn), failure);
        await f.host.initialize();
        expect(failure).not.toHaveBeenCalled();
        expect(cleanup).toHaveLength(1);
    });

    it("continues the host's ordinary initialisation after a cache failure", async () => {
        const f = fixture(),
            original = f.host.initialize,
            failure = vi.fn();
        f.fail();
        f.pruner.install(() => {}, failure);
        await f.host.initialize();
        expect(failure).toHaveBeenCalledOnce();
        expect(original).toHaveBeenCalledOnce();
    });

    it("shares one startup hook between the bootstrap and payload", async () => {
        const f = fixture(),
            cleanup: (() => void)[] = [];
        f.pruner.install(
            (fn) => cleanup.push(fn),
            () => {}
        );
        new MobileMetadataCache(f.app).install(
            (fn) => cleanup.push(fn),
            () => {}
        );
        await f.host.initialize();
        expect(cleanup).toHaveLength(1);
        expect(f.host.preload).toHaveBeenCalledOnce();
    });

    it("restores its hook and preserves a later owner during cleanup", async () => {
        const f = fixture(),
            cleanup: (() => void)[] = [];
        const original = f.host.initialize;
        f.pruner.install(
            (fn) => cleanup.push(fn),
            () => {}
        );
        const filtered = f.host.initialize;
        const later = vi.fn(async () => {
            await filtered();
        });
        f.host.initialize = later;
        cleanup[0]();
        await f.host.initialize();
        expect(f.host.initialize).toBe(later);
        expect(original).toHaveBeenCalledOnce();
        expect(f.host.preload).not.toHaveBeenCalled();
    });

    it("stops further batches when the owner unloads", async () => {
        const f = fixture(1501);
        let running = true;
        f.delayCommit(() => {
            running = false;
            return Promise.resolve();
        });
        const pruned = await f.pruner.pruneMissing(() => running);
        expect(f.transactions).toHaveLength(1);
        expect(pruned).toBe(f.transactions[0].length);
        expect(pruned).toBeLessThan(1501);
        expect(f.persisted.size).toBe(1502 - pruned);
    });

    it("leaves unsupported hosts unchanged and refuses offloading without a cache database", async () => {
        const host = { initialize: vi.fn(async () => {}) };
        const pruner = new MobileMetadataCache({ metadataCache: host } as unknown as App);
        const cleanup = vi.fn();
        pruner.install(cleanup, () => {});
        expect(cleanup).not.toHaveBeenCalled();
        await expect(pruner.forget(["Retired/item.png"])).rejects.toThrow("unavailable");
        const f = fixture();
        Reflect.set(f.host, "db", undefined);
        await expect(f.pruner.forget(["Retired/item-0.png"])).rejects.toThrow("database is unavailable");
        expect(f.host.fileCache["Retired/item-0.png"]).toBeDefined();
    });
});
