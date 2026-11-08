import { describe, expect, it, vi } from "vitest";
import { AttachmentRegistry } from "./AttachmentRegistry";
import type { AttachmentCacheRecord } from "./AttachmentCache";

const record: AttachmentCacheRecord = {
    version: 1,
    path: "Archive/old.png",
    key: "a".repeat(64),
    hash: "b".repeat(64),
    stat: { size: 3, mtime: 10, ctime: 5 },
    phase: "planned",
    revision: "1-original",
};
function harness() {
    const rows = new Map<string, AttachmentCacheRecord>();
    let checkpoint: string | null = null;
    const originals = new Map<string, AttachmentCacheRecord>();
    const storage = {
        keys: async () => [...rows.keys()],
        get: vi.fn(async (key: string) => rows.get(key)),
        set: vi.fn(async (key: string, value: AttachmentCacheRecord) => {
            rows.set(key, value);
        }),
        delete: async (key: string) => {
            rows.delete(key);
        },
    };
    const io = {
        archiveRecoveryRecord: vi.fn(async () => {}),
        readRegistryFingerprint: async () => checkpoint,
        writeRegistryFingerprint: vi.fn(async (value: string) => {
            checkpoint = value;
        }),
        saveRecoveryRecord: vi.fn(async (value: AttachmentCacheRecord) => {
            originals.set(value.key, value);
        }),
    };
    return { rows, io, storage, originals, registry: () => new AttachmentRegistry(storage, io) };
}

describe("durable attachment registry", () => {
    it("starts from keys and one checkpoint without reading every record", async () => {
        const f = harness(),
            first = f.registry();
        await first.load();
        await first.set(record.path, record);
        const next = f.registry();
        await next.load();
        expect(await next.keys()).toEqual([record.path]);
        expect(f.storage.get).not.toHaveBeenCalled();
        expect(f.originals.get(record.key)?.path).toBe(record.path);
    });
    it("detects complete and partial database loss while retaining native recovery descriptions", async () => {
        const f = harness(),
            registry = f.registry();
        await registry.load();
        await registry.set(record.path, record);
        await registry.set("Archive/second.png", { ...record, path: "Archive/second.png", key: "c".repeat(64) });
        f.rows.delete([...f.rows.keys()][0]);
        await expect(f.registry().load()).rejects.toThrow("needs recovery");
        f.rows.clear();
        await expect(f.registry().load()).rejects.toThrow("needs recovery");
        expect(f.originals.size).toBe(2);
    });
    it("does not register or move an original if its independent description cannot be saved", async () => {
        const f = harness(),
            registry = f.registry();
        await registry.load();
        f.io.saveRecoveryRecord.mockRejectedValue(new Error("storage full"));
        await expect(registry.set(record.path, record)).rejects.toThrow("storage full");
        expect(f.rows.size).toBe(0);
        expect(f.io.writeRegistryFingerprint).not.toHaveBeenCalled();
        await expect(registry.set(record.path, record)).rejects.toThrow("unavailable");
    });
    it("detects interruption after database insertion and before the native checkpoint", async () => {
        const f = harness(),
            registry = f.registry();
        await registry.load();
        f.io.writeRegistryFingerprint.mockRejectedValueOnce(new Error("interrupted"));
        await expect(registry.set(record.path, record)).rejects.toThrow("interrupted");
        await expect(f.registry().load()).rejects.toThrow("needs recovery");
        expect(f.originals.size).toBe(1);
    });
    it("serialises concurrent membership changes and preserves metadata after normal restoration", async () => {
        const f = harness(),
            registry = f.registry();
        await registry.load();
        await Promise.all([
            registry.set(record.path, record),
            registry.set("Archive/second.png", { ...record, path: "Archive/second.png", key: "c".repeat(64) }),
        ]);
        await registry.set(record.path, { ...record, phase: "restoring" });
        await registry.delete(record.path);
        const next = f.registry();
        await next.load();
        expect(await next.keys()).toEqual(["Archive/second.png"]);
        expect(f.originals.size).toBe(2);
    });
});
