import { describe, expect, it } from "vitest";
import {
    ReplicationQueuePersistence,
    QUEUE_RECORD_PREFIX,
    QUEUE_SNAPSHOT_KEY,
    type QueueDocumentRecord,
    type QueueSnapshotStore,
} from "./ReplicationQueuePersistence";

type Doc = { _id: string; _rev: string };
const record = (id: string, order = 0): QueueDocumentRecord<Doc> => ({
    doc: { _id: id, _rev: "1-test" },
    order: order.toString(16).padStart(16, "0"),
    waiting: false,
    withoutNotice: false,
});
function fixture(seed = new Map<string, unknown>()) {
    const map = structuredClone(seed);
    let limit = Infinity;
    let operations = 0;
    const guard = () => {
        if (operations++ >= limit) throw new Error("crash");
    };
    const store: QueueSnapshotStore = {
        get: async <T>(key: string) => map.get(key) as T,
        keys: async () => [...map.keys()],
        set: async (key, value) => {
            guard();
            map.set(key, structuredClone(value));
        },
        del: async (key) => {
            guard();
            map.delete(key);
        },
    };
    return {
        map,
        store,
        persistence: new ReplicationQueuePersistence<Doc>(() => store),
        crashAfter(n: number) {
            operations = 0;
            limit = n;
        },
    };
}

describe("durable replication queue records", () => {
    it.each(["insert", "replace", "delete"] as const)("replays %s at every journal interruption", async (kind) => {
        const original = fixture();
        await original.persistence.migrate([{ id: "a", record: record("a") }], []);
        const changed = record(kind === "insert" ? "b" : "a", 9);
        changed.doc._rev = "2-new";
        for (let limit = 0; limit <= 4; limit++) {
            const interrupted = fixture(original.map);
            await interrupted.persistence.load();
            interrupted.crashAfter(limit);
            await interrupted.persistence
                .write([{ id: changed.doc._id, record: kind === "delete" ? undefined : changed }])
                .catch(() => {});
            const restarted = fixture(interrupted.map);
            const { records } = await restarted.persistence.load();
            if (limit === 0) expect(records).toEqual([record("a")]);
            else if (kind === "delete") expect(records).toEqual([]);
            else expect(records.find((entry) => entry.doc._id === changed.doc._id)).toEqual(changed);
            expect(restarted.map.has(`${QUEUE_SNAPSHOT_KEY}:pending`)).toBe(false);
        }
    });

    it("detects an actually deleted document and preserves the remaining snapshot", async () => {
        const f = fixture();
        await f.persistence.migrate(
            ["a", "b"].map((id, order) => ({ id, record: record(id, order) })),
            []
        );
        f.map.delete(`${QUEUE_RECORD_PREFIX}a`);
        const before = structuredClone(f.map);
        await expect(new ReplicationQueuePersistence<Doc>(() => f.store).load()).rejects.toThrow(
            "count does not match"
        );
        expect(f.map).toEqual(before);
    });

    it("resumes partial legacy overflow cleanup after its marker committed", async () => {
        const f = fixture();
        f.map.set("page-a", ["a"]);
        f.map.set("page-b", ["b"]);
        await f.persistence.migrate(
            ["a", "b"].map((id, order) => ({ id, record: record(id, order) })),
            ["page-a", "page-b"]
        );
        f.crashAfter(1);
        await expect(f.persistence.finishCleanup()).rejects.toThrow("crash");
        expect(f.map.has("page-a")).toBe(false);
        expect(f.map.has("page-b")).toBe(true);
        expect(f.map.has(`${QUEUE_SNAPSHOT_KEY}:cleanup`)).toBe(true);
        const restarted = fixture(f.map);
        expect((await restarted.persistence.load()).records).toHaveLength(2);
        expect(restarted.map.has("page-b")).toBe(false);
        expect(restarted.map.has(`${QUEUE_SNAPSHOT_KEY}:cleanup`)).toBe(false);
    });

    it("keeps the new queue authoritative until an atomic legacy export succeeds", async () => {
        const f = fixture();
        await f.persistence.migrate([{ id: "a", record: record("a") }], []);
        const legacy = { queued: [record("a").doc], processing: [], waiting: [] };
        f.crashAfter(0);
        await expect(f.persistence.exportLegacy(legacy)).rejects.toThrow("crash");
        const restarted = fixture(f.map);
        expect((await restarted.persistence.load()).records).toHaveLength(1);
        await restarted.persistence.exportLegacy(legacy);
        expect(restarted.map.get(QUEUE_SNAPSHOT_KEY)).toEqual(legacy);
        expect((await new ReplicationQueuePersistence<Doc>(() => restarted.store).load()).snapshot).toEqual(legacy);
    });
});
