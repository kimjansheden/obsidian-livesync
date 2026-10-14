/** Durable queue records with a bounded redo journal and a constant-size integrity count. */
export interface QueueSnapshotStore {
    get<T>(key: string): Promise<T>;
    set(key: string, value: unknown): Promise<unknown>;
    del?(key: string): Promise<void>;
    keys?(): Promise<IDBValidKey[]>;
}
export interface QueueDocumentRecord<T> {
    doc: T;
    order: string;
    waiting: boolean;
    withoutNotice: boolean;
}
export interface QueueSnapshot<T> {
    queued: T[];
    processing: T[];
    waiting?: T[];
    waitingWithoutNotice?: string[];
    overflow?: string[];
    documentRecords?: true;
    documentCount?: string;
}
export const QUEUE_SNAPSHOT_KEY = "replicationResultProcessorSnapshot";
export const QUEUE_RECORD_PREFIX = `${QUEUE_SNAPSHOT_KEY}:d:`;
const JOURNAL_KEY = `${QUEUE_SNAPSHOT_KEY}:pending`;
const CLEANUP_KEY = `${QUEUE_SNAPSHOT_KEY}:cleanup`;
const WRITE_BATCH = 100;
type Change<T> = { id: string; record: QueueDocumentRecord<T> | undefined };
type Journal<T> = { count: string; changes: Change<T>[] };
const countOf = (count: number) => count.toString(16).padStart(16, "0");
const keyOf = (id: string) => `${QUEUE_RECORD_PREFIX}${encodeURIComponent(id)}`;
const markerOf = <T>(count: string): QueueSnapshot<T> => ({
    queued: [],
    processing: [],
    waiting: [],
    waitingWithoutNotice: [],
    documentRecords: true,
    documentCount: count,
});

export class ReplicationQueuePersistence<T extends { _id: string }> {
    private readonly storedIds = new Set<string>();
    constructor(private readonly store: () => QueueSnapshotStore) {}

    private async remove(key: string): Promise<void> {
        const store = this.store();
        if (store.del) await store.del(key);
        else await store.set(key, null);
    }

    /** A journal is durable before records change. Replaying it is idempotent at every interruption point. */
    private async apply(journal: Journal<T>): Promise<void> {
        const store = this.store();
        for (const { id, record } of journal.changes) {
            if (record) await store.set(keyOf(id), record);
            else await this.remove(keyOf(id));
        }
        await store.set(QUEUE_SNAPSHOT_KEY, markerOf<T>(journal.count));
        for (const { id, record } of journal.changes) {
            if (record) this.storedIds.add(id);
            else this.storedIds.delete(id);
        }
        await this.remove(JOURNAL_KEY);
    }

    private async recover(): Promise<void> {
        const journal = await this.store().get<Journal<T> | null>(JOURNAL_KEY);
        if (journal) await this.apply(journal);
    }

    async load(): Promise<{ snapshot: QueueSnapshot<T> | undefined; records: QueueDocumentRecord<T>[] }> {
        const store = this.store();
        let snapshot = await store.get<QueueSnapshot<T>>(QUEUE_SNAPSHOT_KEY);
        if (!snapshot?.documentRecords) return { snapshot, records: [] };
        await this.recover();
        snapshot = await store.get<QueueSnapshot<T>>(QUEUE_SNAPSHOT_KEY);
        if (!snapshot?.documentCount || !/^[0-9a-f]{16}$/.test(snapshot.documentCount)) {
            throw new Error("The replication queue document record count is invalid");
        }
        if (!store.keys) throw new Error("The replication queue requires key enumeration");
        const records: QueueDocumentRecord<T>[] = [];
        for (const key of await store.keys()) {
            if (typeof key !== "string" || !key.startsWith(QUEUE_RECORD_PREFIX)) continue;
            const record = await store.get<QueueDocumentRecord<T> | null>(key);
            if (record === null) continue;
            if (
                !record?.doc ||
                typeof record.doc._id !== "string" ||
                key !== keyOf(record.doc._id) ||
                typeof record.order !== "string" ||
                !/^[0-9a-f]{16}$/.test(record.order)
            )
                throw new Error("A replication queue document record could not be restored");
            records.push(record);
        }
        if (records.length !== Number.parseInt(snapshot.documentCount, 16)) {
            throw new Error("The replication queue document record count does not match its stored records");
        }
        this.storedIds.clear();
        for (const record of records) this.storedIds.add(record.doc._id);
        await this.finishCleanup();
        records.sort((a, b) => a.order.localeCompare(b.order));
        return { snapshot, records };
    }

    /** Convert once, leaving the legacy snapshot authoritative until every document is written. */
    async migrate(changes: Change<T>[], legacyKeys: string[]): Promise<void> {
        const store = this.store();
        if (!store.keys) throw new Error("The replication queue requires key enumeration");
        const ids = new Set(changes.filter((change) => change.record).map((change) => change.id));
        for (const { id, record } of changes) if (record) await store.set(keyOf(id), record);
        for (const key of await store.keys()) {
            if (
                typeof key === "string" &&
                key.startsWith(QUEUE_RECORD_PREFIX) &&
                !ids.has(decodeURIComponent(key.slice(QUEUE_RECORD_PREFIX.length)))
            )
                await this.remove(key);
        }
        // This list survives the commit, so failure after deleting only some pages can be retried safely.
        if (legacyKeys.length > 0) await store.set(CLEANUP_KEY, legacyKeys);
        await store.set(QUEUE_SNAPSHOT_KEY, markerOf<T>(countOf(ids.size)));
        this.storedIds.clear();
        for (const id of ids) this.storedIds.add(id);
    }

    async write(changes: Change<T>[]): Promise<void> {
        await this.recover();
        for (let from = 0; from < changes.length; from += WRITE_BATCH) {
            const batch = changes.slice(from, from + WRITE_BATCH);
            let count = this.storedIds.size;
            for (const { id, record } of batch)
                count += record ? Number(!this.storedIds.has(id)) : -Number(this.storedIds.has(id));
            const journal: Journal<T> = { changes: batch, count: countOf(count) };
            await this.store().set(JOURNAL_KEY, journal);
            await this.apply(journal);
        }
        await this.finishCleanup();
    }

    async finishCleanup(): Promise<void> {
        const keys = await this.store().get<string[] | null>(CLEANUP_KEY);
        if (!Array.isArray(keys) || keys.length === 0) return;
        for (const key of keys) await this.remove(key);
        await this.remove(CLEANUP_KEY);
    }

    /** The caller holds the snapshot lock. The legacy record flips atomically after dirty records are flushed. */
    async exportLegacy(snapshot: QueueSnapshot<T>): Promise<void> {
        await this.recover();
        await this.store().set(QUEUE_SNAPSHOT_KEY, snapshot);
    }
}
