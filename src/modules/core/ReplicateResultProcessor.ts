import {
    LARGE_FILE_BYTES,
    SYNCINFO_ID,
    VER,
    type AnyEntry,
    type EntryDoc,
    type EntryLeaf,
    type LoadedEntry,
    type MetaEntry,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { ModuleReplicator } from "./ModuleReplicator";
import { isChunk } from "@vrtmrz/livesync-commonlib/compat/common/typeUtils";
import { stripAllPrefixes } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    Logger,
    type LOG_LEVEL,
} from "@vrtmrz/livesync-commonlib/compat/common/logger";
import {
    fireAndForget,
    isAnyNote,
    isRemediationModeActive,
    throttle,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore_v2";
import { serialized } from "octagonal-wheels/concurrency/lock";
import type { ReactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import type { LiveSyncBaseCore } from "@/LiveSyncBaseCore";
import { isNotFoundError } from "@vrtmrz/livesync-commonlib/compat/common/utils.doc";
import type PouchDB from "pouchdb-core";
import { delay, promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";

import {
    ReplicationQueuePersistence,
    QUEUE_SNAPSHOT_KEY,
    type QueueSnapshotStore,
    type QueueSnapshot,
    type QueueDocumentRecord,
} from "./ReplicationQueuePersistence";
const KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT = QUEUE_SNAPSHOT_KEY;
const REPROCESS_BATCH_SIZE = 100;
const REPROCESS_PENDING_KEY = "replicationResultProcessorReprocessPending";
type ReprocessPending = { generation: number; fromStart: boolean };
/** The key which holds how far the reprocessing of a changed filter has come, so a restart continues from there. */
const KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION = "replicationResultProcessorReprocessPosition";
/**
 * The fixed maximum number of queued, processing, and waiting documents kept in the released single record.
 * Larger queues convert once to one record per document. Subsequent writes contain only changed documents.
 */
export const SNAPSHOT_INLINE_LIMIT = 1000;
/** How many documents are enqueued from a stored queue before yielding to the event loop while restoring. */
export const RESTORE_SLICE_SIZE = 1000;
/** The most documents the reprocessing of a changed filter keeps queued at once, so the queue stays bounded. */
export const REPROCESS_QUEUE_LIMIT = 1000;
/** How long the reprocessing waits between checks while the queue drains below its bound. */
const REPROCESS_DRAIN_POLL_MS = 50;

type SnapshotStore = QueueSnapshotStore;
type QueueDoc = PouchDB.Core.ExistingDocument<EntryDoc>;
/** Thrown when a suspended processor cannot drain its bounded reprocessing queue. */
class ReprocessSuspended extends Error {}

/** An insertion-ordered, per-id queue; enqueue, replacement, and dequeue never scan its documents. */
class DocumentQueue {
    private readonly documents = new Map<string, QueueDoc>();
    constructor(private readonly changed: (id: string, appended: boolean) => void) {}
    get size(): number {
        return this.documents.size;
    }
    get(id: string): QueueDoc | undefined {
        return this.documents.get(id);
    }
    enqueue(doc: QueueDoc): void {
        this.documents.delete(doc._id);
        this.documents.set(doc._id, doc);
        this.changed(doc._id, true);
    }
    dequeue(): QueueDoc | undefined {
        const first = this.documents.entries().next();
        if (first.done) return undefined;
        const [id, doc] = first.value;
        this.documents.delete(id);
        this.changed(id, false);
        return doc;
    }
    values(): IterableIterator<QueueDoc> {
        return this.documents.values();
    }
}

type ReplicateResultProcessorState = QueueSnapshot<QueueDoc>;
type DocumentSnapshot = QueueDocumentRecord<QueueDoc>;

type LocalApplicationActivityOwner = {
    runBoundedLocalApplicationActivity<T>(task: () => T | PromiseLike<T>, options?: { label?: string }): Promise<T>;
};
function shortenId(id: string): string {
    return id.length > 10 ? id.substring(0, 10) : id;
}
function shortenRev(rev: string | undefined): string {
    if (!rev) return "undefined";
    return rev.length > 10 ? rev.substring(0, 10) : rev;
}
export class ReplicateResultProcessor {
    private log(message: string, level: LOG_LEVEL = LOG_LEVEL_INFO) {
        Logger(`[ReplicateResultProcessor] ${message}`, level);
    }
    private logError(e: unknown) {
        Logger(e, LOG_LEVEL_VERBOSE);
    }
    private replicator: ModuleReplicator;

    constructor(replicator: ModuleReplicator) {
        this.replicator = replicator;
    }

    get localDatabase() {
        return this.replicator.core.localDatabase;
    }
    get services() {
        return this.replicator.core.services;
    }
    get core(): LiveSyncBaseCore {
        return this.replicator.core;
    }

    getPath(entry: AnyEntry): string {
        return this.services.path.getPath(entry);
    }

    public suspend() {
        this._suspended = true;
        this.updateProcessingActivity();
    }
    public resume() {
        this._suspended = false;
        this.resumeAfterApplicationReady();
    }

    /** Whether a filter reprocess stopped on suspension and should continue when the processor resumes. */
    private _reprocessInterrupted = false;
    /**
     * Continue processing which was held back while the application was not ready.
     * An explicit suspension remains in effect.
     */
    public resumeAfterApplicationReady() {
        this.updateProcessingActivity();
        this.triggerProcessQueue();
        // A filter reprocess which stopped because the processor was suspended continues from its stored position,
        // whether suspension cleared through resume() or through the application becoming ready.
        if (this._reprocessInterrupted && !this.isSuspended) {
            this._resumeReprocess();
        }
    }

    private _resumeReprocess(): void {
        this._reprocessInterrupted = false;
        const finishing = this._reprocessRun;
        fireAndForget(async () => {
            // A readiness/content event can arrive while a suspended pass is still returning.
            if (finishing) await finishing;
            if (!this.isSuspended) await this._startReprocess();
        });
    }

    // Whether the processing is suspended
    // If true, the processing queue processor bails the loop.
    private _suspended: boolean = false;

    /**
     * Whether the application accepts replicated documents being applied to storage.
     *
     * Remediation mode prevents the reconciliation scan which readiness depends upon, so the
     * application stays unready for as long as the limit is configured. Applying the received
     * documents is what that mode exists for, and `parseDocumentChange` keeps each one within
     * the configured modification-time limit. Application still waits for a usable database.
     */
    private get acceptsResultApplication() {
        if (this.core.services.appLifecycle.isReady()) return true;
        if (!isRemediationModeActive(this.replicator.settings)) return false;
        // A fetch resets the local database, and a remote which reflects while fetching leaves
        // this processor unsuspended throughout. Documents applied then cannot gather their
        // chunks and are dropped, so the database itself must be usable.
        return this.core.services.database.isDatabaseReady();
    }

    public get isSuspended() {
        return (
            this._suspended ||
            this._snapshotPinnedForDowngrade ||
            !this.acceptsResultApplication ||
            this.replicator.settings.suspendParseReplicationResult ||
            this.core.services.appLifecycle.isSuspended()
        );
    }

    /**
     * Take a snapshot of the current processing state.
     * This snapshot is stored in the KV database for recovery on restart.
     */
    protected async _takeSnapshot() {
        // Until the snapshot of the previous run has been restored, it is the only record of that run's queue.
        if (!this._snapshotRestored) {
            this.reportStatus();
            return;
        }
        // Serialise snapshots so a failed write can be retried before a later snapshot changes the same records.
        await serialized(KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT, async () => {
            if (!this._snapshotPinnedForDowngrade) await this._writeSnapshot();
        });
    }

    private async _writeSnapshot() {
        const store = this.core.kvDB as unknown as SnapshotStore;
        const baseKey = KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT;
        const pending = this._queuedChanges.size + this._processingChanges.length + this._waitingChanges.size;
        if (!this._documentSnapshots && pending <= SNAPSHOT_INLINE_LIMIT) {
            // Small queues retain the released shape, with a fixed upper bound on all document arrays together.
            const dirty = [...this._snapshotDirty];
            this._snapshotDirty.clear();
            const snapshot = {
                queued: [...this._queuedChanges.values()],
                processing: this._processingChanges.slice(),
                waiting: [...this._waitingChanges.values()],
                waitingWithoutNotice: [...this._waitingWithoutNotice],
            } satisfies ReplicateResultProcessorState;
            try {
                await store.set(baseKey, snapshot);
            } catch (error) {
                for (const id of dirty) this._snapshotDirty.add(id);
                throw error;
            }
            if (store.del) for (const key of this._storedOverflowKeys) await store.del(key);
            this._storedOverflowKeys = [];
            for (const id of dirty) {
                if (!this._snapshotDirty.has(id) && !this._documentSnapshot(id)) this._snapshotOrder.delete(id);
            }
            this.reportStatus();
            return;
        }
        const migrating = !this._documentSnapshots;
        const ids = migrating
            ? new Set(
                  [...this._queuedChanges.values(), ...this._processingChanges, ...this._waitingChanges.values()].map(
                      (doc) => doc._id
                  )
              )
            : new Set(this._snapshotDirty);
        for (const id of ids) this._snapshotDirty.delete(id);
        const records = [...ids].map((id) => ({ id, record: this._documentSnapshot(id) }));
        try {
            if (migrating) {
                await this._queuePersistence.migrate(records, this._storedOverflowKeys);
                this._documentSnapshots = true;
            } else {
                await this._queuePersistence.write(records);
            }
        } catch (error) {
            for (const id of ids) this._snapshotDirty.add(id);
            throw error;
        }
        // Cleanup is independently durable. A failure after the marker commits never dirties every saved record.
        await this._queuePersistence.finishCleanup();
        this._storedOverflowKeys = [];
        for (const { id, record } of records) {
            if (!record && !this._snapshotDirty.has(id)) this._snapshotOrder.delete(id);
        }
        this.reportStatus();
    }

    private _snapshotStoreOpened = false;
    private readonly _queuePersistence = new ReplicationQueuePersistence<QueueDoc>(() => {
        const store = this.core.kvDB;
        this._snapshotStoreOpened = true;
        return store;
    });
    private _hydratingSnapshot = false;
    private _snapshotPinnedForDowngrade = false;
    private _snapshotDowngradeGeneration = 0;

    /** Export a complete legacy snapshot before a release swap or restoration of an older build. */
    public async exportSnapshotForDowngrade() {
        try {
            if (!this.core.kvDB) throw new Error("The key-value database is not initialised");
        } catch (error) {
            // Before this instance ever opened the queue store it cannot have converted its predecessor's export.
            if (!this._snapshotStoreOpened && !this._snapshotRestored) return;
            throw error;
        }
        const generation = ++this._snapshotDowngradeGeneration;
        this._snapshotPinnedForDowngrade = true;
        let cancelled = false;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            if (generation !== this._snapshotDowngradeGeneration || this.core.services.control.hasUnloaded()) return;
            this._snapshotPinnedForDowngrade = false;
            this.resumeAfterApplicationReady();
            this.triggerTakeSnapshot();
        };
        try {
            await this.restoreFromSnapshotOnce();
            await serialized(KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT, async () => {
                await this._writeSnapshot();
                const snapshot: ReplicateResultProcessorState = {
                    queued: [...this._queuedChanges.values()],
                    processing: this._processingChanges.slice(),
                    waiting: [...this._waitingChanges.values()],
                    waitingWithoutNotice: [...this._waitingWithoutNotice],
                };
                const dirty = [...this._snapshotDirty];
                this._snapshotDirty.clear();
                try {
                    await this._queuePersistence.exportLegacy(snapshot);
                    this._documentSnapshots = false;
                } catch (error) {
                    for (const id of dirty) this._snapshotDirty.add(id);
                    throw error;
                }
                if (this._snapshotDirty.size > 0)
                    throw new Error("The replication queue changed while preparing an older build");
            });
        } catch (error) {
            cancel();
            throw error;
        }
        // Pending and throttled snapshots check the pin inside the same lock; none can undo this export.
        return {
            isCurrent: () =>
                !cancelled &&
                generation === this._snapshotDowngradeGeneration &&
                this._snapshotPinnedForDowngrade &&
                this._snapshotDirty.size === 0,
            cancel,
        };
    }

    private _documentSnapshot(id: string): DocumentSnapshot | undefined {
        const queued = this._queuedChanges.get(id);
        const processing = this._processingById.get(id);
        const waiting = this._waitingChanges.get(id);
        const doc = queued ?? processing ?? waiting;
        if (!doc) return undefined;
        return {
            doc,
            order: (this._snapshotOrder.get(id) ?? 0).toString(16).padStart(16, "0"),
            waiting: !queued && !processing && waiting !== undefined,
            withoutNotice: waiting?._rev === doc._rev && this._waitingWithoutNotice.has(id),
        };
    }
    private _markSnapshotDirty(id: string, appended = false): void {
        if (this._hydratingSnapshot) return;
        this._snapshotDirty.add(id);
        if (appended || !this._snapshotOrder.has(id)) this._snapshotOrder.set(id, this._snapshotNextOrder++);
    }
    /**
     * Trigger taking a snapshot.
     */
    protected _triggerTakeSnapshot() {
        fireAndForget(() => this._takeSnapshot());
    }
    /**
     * Throttled version of triggerTakeSnapshot.
     */
    protected triggerTakeSnapshot = throttle(() => this._triggerTakeSnapshot(), 50);

    /**
     * Restore from snapshot.
     */
    public async restoreFromSnapshot() {
        const store = this.core.kvDB as unknown as SnapshotStore;
        const { snapshot, records } = await this._queuePersistence.load();
        if (!snapshot) {
            await this._restoreReprocessState(store);
            this._snapshotRestored = true;
            this.resumeAfterApplicationReady();
            return;
        }
        for (const record of records) {
            const order = Number.parseInt(record.order, 16);
            this._snapshotNextOrder = Math.max(this._snapshotNextOrder, order + 1);
            if (!this._snapshotDirty.has(record.doc._id)) this._snapshotOrder.set(record.doc._id, order);
        }
        // Read every referenced record before allowing a snapshot to replace the previous run's state.
        const restoredWaiting = records.filter((record) => record.waiting);
        const waiting = [...(snapshot.waiting ?? []), ...restoredWaiting.map((record) => record.doc)];
        // Released array/page snapshots have no order fields. Assign their FIFO order once before conversion.
        if (!snapshot.documentRecords) {
            for (const doc of [...snapshot.processing, ...(snapshot.queued ?? []), ...waiting]) {
                if (!this._snapshotOrder.has(doc._id)) this._snapshotOrder.set(doc._id, this._snapshotNextOrder++);
            }
        }
        // A snapshot of an earlier version names none, as it gave every notice at once.
        const waitingWithoutNotice = new Set([
            ...(snapshot.waitingWithoutNotice ?? []),
            ...restoredWaiting.filter((record) => record.withoutNotice).map((record) => record.doc._id),
        ]);
        for (const doc of waiting) {
            if (this._waitingChanges.has(doc._id)) continue;
            this._waitingChanges.set(doc._id, doc);
            // The notice which was held back for it is still due when its content turns out not to come.
            if (waitingWithoutNotice.has(doc._id)) this._waitingWithoutNotice.add(doc._id);
        }
        // The overflow keys the record names hold the queued documents past the head page, in order.
        const overflow: QueueDoc[] = records.filter((record) => !record.waiting).map((record) => record.doc);
        const storedKeys = Array.isArray(snapshot.overflow) ? snapshot.overflow : [];
        for (const key of storedKeys) {
            const page = await store.get<QueueDoc[] | undefined>(key);
            if (!Array.isArray(page)) throw new Error("A replication queue overflow page could not be restored");
            for (const doc of page) {
                if (!this._snapshotOrder.has(doc._id)) this._snapshotOrder.set(doc._id, this._snapshotNextOrder++);
            }
            overflow.push(...page);
        }
        // Legacy pages remain authoritative until conversion commits its constant base marker.
        this._storedOverflowKeys = storedKeys;

        // Restoring re-runs processing for the processing items, the queued ones, and the overflow, before what
        // was enqueued meanwhile. Enqueueing is O(1) per document, and runs in slices so a large queue does not
        // block the event loop: a single stretch is at most RESTORE_SLICE_SIZE documents.
        const carried = [...this._queuedChanges.values()];
        // Arrivals before the stored order was read belong after that saved queue, including after another restart.
        for (const doc of carried) this._snapshotOrder.set(doc._id, this._snapshotNextOrder++);
        this._queuedChanges = new DocumentQueue((id, appended) => this._markSnapshotDirty(id, appended));
        const carriedIds = new Set(carried.map((doc) => doc._id));
        const toQueue = [
            ...[...snapshot.processing, ...(snapshot.queued ?? []), ...overflow].filter(
                (doc) => !carriedIds.has(doc._id)
            ),
            ...carried,
        ];
        // Not yet restored: enqueueAll below fires a throttled snapshot per slice, and a replication event may fire
        // one too. Taking a snapshot now would persist only the prefix enqueued so far over the complete stored
        // snapshot, and a crash would then lose the un-restored tail. `_takeSnapshot` stays blocked until the flag
        // below, so the stored snapshot is replaced only once every page has been read and enqueued.
        for (let from = 0; from < toQueue.length; from += RESTORE_SLICE_SIZE) {
            this._hydratingSnapshot = true;
            try {
                this.enqueueAll(toQueue.slice(from, from + RESTORE_SLICE_SIZE));
            } finally {
                this._hydratingSnapshot = false;
            }
            if (from + RESTORE_SLICE_SIZE < toQueue.length) await delay(0);
        }
        // The whole queue is restored; from here a snapshot persists the complete state, never a partial prefix.
        await this._restoreReprocessState(store);
        this._documentSnapshots = snapshot.documentRecords === true;
        this._snapshotRestored = true;
        this.resumeAfterApplicationReady();
        this.log(
            `Restored from snapshot (${toQueue.length - carried.length} items, ${waiting.length} waiting for their content)`,
            LOG_LEVEL_INFO
        );
    }

    private async _restoreReprocessState(store: SnapshotStore): Promise<void> {
        const pending = await store.get<ReprocessPending>(REPROCESS_PENDING_KEY);
        const position = await store.get<string>(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION);
        const validPending = pending && Number.isSafeInteger(pending.generation);
        if (validPending) this._reprocessGeneration = Math.max(this._reprocessGeneration, pending.generation);
        this._reprocessInterrupted = Boolean(validPending) || (typeof position === "string" && position !== "");
    }

    private _restoreFromSnapshot: Promise<void> | undefined = undefined;

    /** Whether the snapshot of the previous run has been restored; no snapshot is taken before that. */
    private _snapshotRestored = false;

    /**
     * Restore from snapshot only once.
     *
     * A restoration which fails is tried again by the next call. Until one succeeds, no snapshot is taken, so the
     * stored queue of the previous run is not replaced.
     * @returns Promise that resolves when restoration is complete.
     */
    public restoreFromSnapshotOnce() {
        if (!this._restoreFromSnapshot) {
            this._restoreFromSnapshot = this.restoreFromSnapshot().catch((error: unknown) => {
                this._restoreFromSnapshot = undefined;
                throw error;
            });
        }
        return this._restoreFromSnapshot;
    }

    /**
     * Perform the given procedure while counting the concurrency.
     * @param proc async procedure to perform
     * @param countValue reactive source to count concurrency
     * @returns result of the procedure
     */
    async withCounting<T>(proc: () => Promise<T>, countValue: ReactiveSource<number>) {
        countValue.value++;
        try {
            return await proc();
        } finally {
            countValue.value--;
        }
    }

    /**
     * Report the current status.
     */
    protected reportStatus() {
        this.services.replication.replicationResultCount.value =
            this._queuedChanges.size + this._processingChanges.length;
    }

    /**
     * Enqueue all the given changes for processing.
     * @param changes Changes to enqueue
     */

    public enqueueAll(changes: PouchDB.Core.ExistingDocument<EntryDoc>[]) {
        for (const change of changes) {
            // Check if the change is not a document change (e.g., chunk, versioninfo, syncinfo), and processed it directly.
            const isProcessed = this.processIfNonDocumentChange(change);
            if (!isProcessed) {
                this.enqueueChange(change);
            }
        }
    }

    /**
     * Requeues stored normal-file metadata after its reflection filters change.
     * Replication checkpoints may already cover documents which were skipped
     * by the previous filter, so a later ordinary sync cannot emit them again.
     */
    private _reprocessRun: Promise<number> | undefined;
    private _reprocessGeneration = 0;

    public async reprocessStoredDocuments(): Promise<number> {
        const store = this.core.kvDB as unknown as SnapshotStore;
        if (!store) return (await this._reprocessStoredDocuments(0, "")).count;
        const generation = ++this._reprocessGeneration;
        // A changed filter is durable before the generator is opened or any first-batch work can be lost.
        await serialized(REPROCESS_PENDING_KEY, async () => {
            await store.set(REPROCESS_PENDING_KEY, { generation, fromStart: true } satisfies ReprocessPending);
        });
        let count = await this._startReprocess();
        // A request can arrive while the finishing promise of the previous pass is still held.
        if (!this._reprocessInterrupted && (await store.get<ReprocessPending>(REPROCESS_PENDING_KEY)))
            count += await this._startReprocess();
        return count;
    }

    private _startReprocess(): Promise<number> {
        return (this._reprocessRun ??= Promise.resolve()
            .then(() => this._runReprocessPasses())
            .finally(() => {
                this._reprocessRun = undefined;
            }));
    }

    private async _removeReprocessKey(store: SnapshotStore, key: string): Promise<void> {
        if (store.del) await store.del(key);
        else await store.set(key, undefined);
    }

    private async _runReprocessPasses(): Promise<number> {
        const store = this.core.kvDB as unknown as SnapshotStore;
        await this.restoreFromSnapshotOnce();
        let total = 0;
        for (;;) {
            let pending = await store.get<ReprocessPending>(REPROCESS_PENDING_KEY);
            if (!pending || !Number.isSafeInteger(pending.generation)) {
                const oldPosition = await store.get<string>(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION);
                if (typeof oldPosition !== "string" || oldPosition === "") return total;
                pending = { generation: ++this._reprocessGeneration, fromStart: false };
                await store.set(REPROCESS_PENDING_KEY, pending);
            }
            const pass = pending;
            await serialized(REPROCESS_PENDING_KEY, async () => {
                const current = await store.get<ReprocessPending>(REPROCESS_PENDING_KEY);
                if (current?.generation !== pass.generation) return;
                if (pass.fromStart) await this._removeReprocessKey(store, KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION);
                await store.set(REPROCESS_PENDING_KEY, { ...pass, fromStart: false });
            });
            const position = pass.fromStart
                ? ""
                : ((await store.get<string>(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION)) ?? "");
            // Reconsider old waiting entries before the capacity gate: a new filter may free their slots.
            let removedWaiting = false;
            for (const doc of [...this._waitingChanges.values()]) {
                if (!isAnyNote(doc)) continue;
                const maximum = this.replicator.settings.maxMTimeForReflectEvents;
                if (
                    (maximum > 0 && (doc.mtime ?? 0) > maximum) ||
                    !(await this.services.vault.isTargetFile(this.getPath(doc))) ||
                    this.services.vault.isFileSizeTooLarge(doc.size)
                ) {
                    removedWaiting = true;
                    this.stopWaiting(doc);
                }
            }
            if (removedWaiting) await this._takeSnapshot();
            const result = await this._reprocessStoredDocuments(pass.generation, position);
            total += result.count;
            if (!result.complete) return total;
            const completed = await serialized(REPROCESS_PENDING_KEY, async () => {
                const current = await store.get<ReprocessPending>(REPROCESS_PENDING_KEY);
                if (current?.generation !== pass.generation) return false;
                await this._removeReprocessKey(store, KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION);
                await this._removeReprocessKey(store, REPROCESS_PENDING_KEY);
                return true;
            });
            if (completed) return total;
            // A newer filter requires a full pass, including documents the earlier pass already visited.
        }
    }

    private pendingDocumentCount(): number {
        return this._queuedChanges.size + this._processingChanges.length + this._waitingChanges.size;
    }

    private async _reprocessStoredDocuments(
        generation: number,
        resumeFrom: string
    ): Promise<{ count: number; complete: boolean }> {
        const store = this.core.kvDB as unknown as SnapshotStore;
        let count = 0;
        let position = resumeFrom;
        let batch: PouchDB.Core.ExistingDocument<EntryDoc>[] = [];
        const flush = async () => {
            if (batch.length === 0) return;
            while (this.pendingDocumentCount() + batch.length > REPROCESS_QUEUE_LIMIT) await waitForCapacity();
            this.enqueueAll(batch);
            batch = [];
            if (store) {
                // Persist the batch durably before advancing the stored position. enqueueAll only schedules a
                // throttled snapshot, so without this a stop after the position write but before that snapshot
                // commits would skip the batch on the next run — the position would have moved past documents no
                // snapshot ever kept, losing them. A stop before the position advances instead re-reads from the old
                // position and reprocesses the batch, which is idempotent. The snapshot is awaited, and serialises
                // with the throttled ones. The position is stored only once the batch is persisted, so what is on
                // disk never runs ahead of it.
                await this._takeSnapshot();
                // Advance the durable position only when the snapshot actually persisted. _takeSnapshot does nothing
                // until the restore has completed, so without this a reprocess racing the restore would move the
                // position past a batch that was never written; the batch stays re-reprocessable until it is kept.
                if (this._snapshotRestored) {
                    await serialized(REPROCESS_PENDING_KEY, async () => {
                        const pending = await store.get<ReprocessPending>(REPROCESS_PENDING_KEY);
                        if (pending?.generation === generation)
                            await store.set(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION, position);
                    });
                }
            }
            while (this.pendingDocumentCount() >= REPROCESS_QUEUE_LIMIT) await waitForCapacity();
        };
        const waitForCapacity = async () => {
            // Missing content cannot drain until another receive; persist the cursor and continue after it arrives.
            if (
                this.isSuspended ||
                (this._queuedChanges.size === 0 &&
                    this._processingChanges.length === 0 &&
                    this._waitingChanges.size > 0)
            ) {
                this._reprocessInterrupted = true;
                throw new ReprocessSuspended();
            }
            this.triggerProcessQueue();
            await delay(REPROCESS_DRAIN_POLL_MS);
        };
        let lastSeenId: string | undefined;
        try {
            for await (const document of this.localDatabase.findAllNormalDocs()) {
                // The resume skip below relies on an ascending id order; fail loudly if the library ever breaks it,
                // rather than silently skipping documents a lower position would cover.
                if (lastSeenId !== undefined && document._id <= lastSeenId) {
                    throw new Error(
                        `findAllNormalDocs yielded ${document._id} after ${lastSeenId}, out of ascending id order`
                    );
                }
                lastSeenId = document._id;
                // A document at or before the stored position is already processed.
                if (resumeFrom !== "" && document._id <= resumeFrom) continue;
                batch.push(document);
                count++;
                position = document._id;
                if (batch.length >= REPROCESS_BATCH_SIZE) await flush();
            }
            await flush();
        } catch (error) {
            if (error instanceof ReprocessSuspended) {
                this.log(
                    `Reprocessing is suspended after ${count} document(s); it continues when resumed`,
                    LOG_LEVEL_INFO
                );
                return { count, complete: false };
            }
            throw error;
        }
        this.log(`Requeued ${count} stored document(s) after the reflection filters changed`, LOG_LEVEL_INFO);
        return { count, complete: true };
    }
    /**
     * Process the change if it is not a document change.
     * @param change Change to process
     * @returns True if the change was processed; false otherwise
     */
    protected processIfNonDocumentChange(change: PouchDB.Core.ExistingDocument<EntryDoc>) {
        if (!change) {
            this.log(`Received empty change`, LOG_LEVEL_VERBOSE);
            return true;
        }
        if (isChunk(change._id)) {
            // Emit event for new chunk
            this.localDatabase.onNewLeaf(change as EntryLeaf);
            this.log(`Processed chunk: ${shortenId(change._id)}`, LOG_LEVEL_DEBUG);
            return true;
        }
        if (change.type == "versioninfo") {
            this.log(`Version info document received: ${change._id}`, LOG_LEVEL_VERBOSE);
            if (change.version > VER) {
                // Incompatible version, stop replication.
                this.core.replicator.closeReplication();
                this.log(
                    `Remote database updated to incompatible version. update your Self-hosted LiveSync plugin.`,
                    LOG_LEVEL_NOTICE
                );
            }
            return true;
        }
        if (
            change._id == SYNCINFO_ID || // Synchronisation information data
            change._id.startsWith("_design") //design document
        ) {
            this.log(`Skipped system document: ${change._id}`, LOG_LEVEL_VERBOSE);
            return true;
        }
        return false;
    }

    /**
     * Queue of changes to be processed, de-duplicated by id, with O(1) enqueue, replacement, and dequeue.
     */
    private _queuedChanges = new DocumentQueue((id, appended) => this._markSnapshotDirty(id, appended));
    /** The overflow keys the committed base record names, deleted once a later base names a different set. */
    private _storedOverflowKeys: string[] = [];
    private _documentSnapshots = false;
    private readonly _snapshotDirty = new Set<string>();
    private readonly _snapshotOrder = new Map<string, number>();
    private _snapshotNextOrder = 0;
    private readonly _processingById = new Map<string, QueueDoc>();

    /**
     * List of changes being processed.
     */
    private _processingChanges: PouchDB.Core.ExistingDocument<EntryDoc>[] = [];

    /**
     * Documents which could not be applied yet, by ID, until their revision is written or replaced.
     *
     * Usually their chunks have not arrived, for example after a receive was interrupted, and arrive with a later
     * synchronisation, so they are queued again before each one. They are part of the snapshot, so they also survive
     * a restart.
     */
    private _waitingChanges = new Map<string, PouchDB.Core.ExistingDocument<EntryDoc>>();

    /**
     * Queue the waiting documents again, before a synchronisation which may bring their chunks.
     *
     * A document which is already queued or being processed is left to that entry, which is at least as new.
     */
    public retryWaitingChanges() {
        const waiting = [...this._waitingChanges.values()].filter(
            (doc) => !this._queuedChanges.get(doc._id) && !this._processingById.has(doc._id)
        );
        if (waiting.length === 0) return;
        this.log(`Trying ${waiting.length} document(s) again which could not be applied yet`, LOG_LEVEL_INFO);
        this.enqueueAll(waiting);
    }

    /**
     * Whether content is still to come which the active replicator puts off receiving, such as large chunks.
     *
     * The replicator is looked for without reporting that none is active, as this is asked whenever a document is
     * applied.
     */
    private isContentStillToCome(): boolean {
        return this.services.replicator.peekActiveReplicator()?.hasDeferredRemoteContent() ?? false;
    }

    /**
     * Keep a document which could not be applied, to try it again before the next synchronisation.
     *
     * Only the first failure of a revision is a notice; its repeats are logged quietly.
     *
     * @param isMissingContent whether the document waits because its content could not be gathered. While content
     * is still to come that is expected, so the notice is held back until a failure finds nothing more to come, or
     * is of another kind.
     */
    private keepWaiting(doc: PouchDB.Core.ExistingDocument<EntryDoc>, reason: string, isMissingContent = false) {
        const alreadyWaiting = this._waitingChanges.get(doc._id)?._rev === doc._rev;
        this._waitingChanges.set(doc._id, doc);
        this._markSnapshotDirty(doc._id);
        let level: LOG_LEVEL = alreadyWaiting ? LOG_LEVEL_VERBOSE : LOG_LEVEL_NOTICE;
        if (isMissingContent && this.isContentStillToCome()) {
            if (!alreadyWaiting) {
                this._waitingWithoutNotice.add(doc._id);
                level = LOG_LEVEL_INFO;
            }
        } else if (this._waitingWithoutNotice.delete(doc._id)) {
            // Nothing excuses the silence any more: no content is to come, or the content came and the document
            // fails for another reason.
            level = LOG_LEVEL_NOTICE;
        }
        this.log(`${reason}; it is tried again before the next synchronisation`, level);
        this.triggerTakeSnapshot();
    }

    /**
     * The waiting documents whose missing content has not been reported with a notice, because it was still to come.
     * They are part of the snapshot like the waiting documents, so the notice is not lost by a restart.
     */
    private _waitingWithoutNotice = new Set<string>();

    /** Stop waiting for a document once its waiting revision has been written, replaced, or cannot be applied at all. */
    private stopWaiting(doc: { _id: string; _rev?: string }) {
        if (this._waitingChanges.get(doc._id)?._rev !== doc._rev) return;
        this._waitingChanges.delete(doc._id);
        this._waitingWithoutNotice.delete(doc._id);
        this._markSnapshotDirty(doc._id);
        this.triggerTakeSnapshot();
        if (this._reprocessInterrupted && !this.isSuspended && this.pendingDocumentCount() < REPROCESS_QUEUE_LIMIT) {
            this._resumeReprocess();
        }
    }

    private _processingActivity?: Promise<void>;
    private _processingActivityDone?: PromiseWithResolvers<void>;

    private updateProcessingActivity() {
        if (this.isSuspended) {
            this._processingActivityDone?.resolve();
            return;
        }
        const hasPendingDocuments = this._queuedChanges.size > 0 || this._processingChanges.length > 0;
        if (!hasPendingDocuments) {
            this._processingActivityDone?.resolve();
            return;
        }
        if (this._processingActivity) return;

        const activityDone = promiseWithResolvers<void>();
        this._processingActivityDone = activityDone;
        const activityOwner = this.services.replicator as typeof this.services.replicator &
            Partial<LocalApplicationActivityOwner>;
        this._processingActivity = (
            activityOwner.runBoundedLocalApplicationActivity
                ? activityOwner.runBoundedLocalApplicationActivity(() => activityDone.promise, {
                      label: "replicated-document-application",
                  })
                : activityDone.promise
        )
            .catch((error) => this.logError(error))
            .finally(() => {
                if (this._processingActivityDone === activityDone) this._processingActivityDone = undefined;
                this._processingActivity = undefined;
                this.updateProcessingActivity();
            });
    }

    /**
     * Enqueue the given document change for processing.
     * @param doc Document change to enqueue
     * @returns
     */
    protected enqueueChange(doc: PouchDB.Core.ExistingDocument<EntryDoc>) {
        // The index finds any queued revision of this id without a scan of the queue.
        const old = this._queuedChanges.get(doc._id);
        const path = "path" in doc ? this.getPath(doc) : "<unknown>";
        const docNote = `${path} (${shortenId(doc._id)}, ${shortenRev(doc._rev)})`;
        if (old) {
            if (this._hydratingSnapshot) return;
            if (old._rev == doc._rev) {
                this.log(`[Enqueue] skipped (Already queued): ${docNote}`, LOG_LEVEL_VERBOSE);
                return;
            }
            // The queue holds one entry per id, the latest to arrive: processing always reads the current
            // database winner for the id rather than the queued document, so an earlier queued revision, deleted
            // or not, would be processed to the same end. The start-up scan reconciles anything a collapse could
            // skip. So a new revision replaces the queued one in place.
            this.log(`[Enqueue] requeued: ${docNote} (from rev: ${shortenRev(old._rev ?? "")})`, LOG_LEVEL_VERBOSE);
        }
        this._queuedChanges.enqueue(doc);
        this.updateProcessingActivity();
        this.triggerTakeSnapshot();
        this.triggerProcessQueue();
    }

    /**
     * Trigger processing of the queued changes.
     */
    protected triggerProcessQueue() {
        fireAndForget(() => this.runProcessQueue());
    }

    /**
     * Semaphore to limit concurrent processing.
     * This is the per-id semaphore + concurrency-control (max 10 concurrent = 10 documents being processed at the same time).
     */
    private _semaphore = Semaphore(10);

    /**
     * Semaphore for documents of at least `LARGE_FILE_BYTES`, which are applied one at a time.
     *
     * Applying such a document can hold memory in proportion to its size, and several at once exhaust the memory of a
     * mobile device. They do not take the slots of the other documents, which go on in parallel beside them.
     */
    private _largeDocumentSemaphore = Semaphore(1);

    /**
     * Whether applying a document can hold memory in proportion to a large file.
     *
     * That is so when the document is large, and also when the local file it replaces or deletes is, because a local
     * file which may hold unsynchronised changes is read whole before it is replaced.
     */
    private async isLargeDocument(doc: PouchDB.Core.ExistingDocument<AnyEntry>): Promise<boolean> {
        if (!isAnyNote(doc)) return false;
        if ((doc.size ?? 0) >= LARGE_FILE_BYTES) return true;
        try {
            const local = await this.core.serviceModules.storageAccess.stat(
                stripAllPrefixes(this.services.path.getPath(doc))
            );
            return (local?.size ?? 0) >= LARGE_FILE_BYTES;
        } catch (error) {
            this.logError(error);
            return false;
        }
    }

    /**
     * Flag indicating whether the process queue is currently running.
     */
    private _isRunningProcessQueue: boolean = false;

    /**
     * Process the queued changes.
     */
    private async runProcessQueue() {
        // Avoid re-entrance, suspend processing, or empty queue loop consumption.
        if (this._isRunningProcessQueue) return;
        if (this.isSuspended) return;
        if (this._queuedChanges.size == 0) return;
        try {
            this._isRunningProcessQueue = true;
            while (this._queuedChanges.size > 0) {
                // If getting suspended, bail the loop. Some concurrent tasks may still be running.
                if (this.isSuspended) {
                    this.log(
                        `Processing has got suspended. Remaining items in queue: ${this._queuedChanges.size}`,
                        LOG_LEVEL_INFO
                    );
                    break;
                }

                // Acquire semaphore for new processing slot
                // (per-document serialisation caps concurrency).
                const releaser = await this._semaphore.acquire();
                releaser();
                // Dequeue the next change
                const doc = this._queuedChanges.dequeue();
                if (doc) {
                    this._processingChanges.push(doc);
                    this._processingById.set(doc._id, doc);
                    void this.parseDocumentChange(doc);
                }
                // Take snapshot (to be restored on next startup if needed)
                this.triggerTakeSnapshot();
            }
        } finally {
            this._isRunningProcessQueue = false;
        }
    }

    // Phase 1: parse replication result
    /**
     * Parse the given document change.
     * @param change
     * @returns
     */
    async parseDocumentChange(change: PouchDB.Core.ExistingDocument<EntryDoc>) {
        try {
            // A document which is skipped here is never applied, so it no longer waits either.
            if (isAnyNote(change)) {
                const docMtime = change.mtime ?? 0;
                const maxMTime = this.replicator.settings.maxMTimeForReflectEvents;
                if (maxMTime > 0 && docMtime > maxMTime) {
                    const docPath = this.getPath(change);
                    this.log(
                        `Processing ${docPath} has been skipped due to modification time (${new Date(
                            docMtime * 1000
                        ).toISOString()}) exceeding the limit`,
                        LOG_LEVEL_INFO
                    );
                    this.stopWaiting(change);
                    return;
                }
            }
            // If the document is a virtual document, process it in the virtual document processor.
            if (await this.services.replication.processVirtualDocument(change)) {
                this.stopWaiting(change);
                return;
            }
            // If the document is version info, check compatibility and return.
            if (isAnyNote(change)) {
                const docPath = this.getPath(change);
                if (!(await this.services.vault.isTargetFile(docPath))) {
                    this.log(`Skipped: ${docPath}`, LOG_LEVEL_VERBOSE);
                    this.stopWaiting(change);
                    return;
                }
                const size = change.size;
                // Note that this size check depends size that in metadata, not the actual content size.
                if (this.services.vault.isFileSizeTooLarge(size)) {
                    this.log(
                        `Processing ${docPath} has been skipped due to file size exceeding the limit`,
                        LOG_LEVEL_NOTICE
                    );
                    this.stopWaiting(change);
                    return;
                }
                return await this.applyToDatabase(change);
            }
            this.log(`Skipped unexpected non-note document: ${change._id}`, LOG_LEVEL_INFO);
            return;
        } finally {
            // Remove from processing queue
            this._processingChanges = this._processingChanges.filter((e) => e !== change);
            if (this._processingById.get(change._id) === change) this._processingById.delete(change._id);
            this._markSnapshotDirty(change._id);
            try {
                if (this._queuedChanges.size === 0 && this._processingChanges.length === 0) {
                    try {
                        await this._takeSnapshot();
                    } catch (error) {
                        this.logError(error);
                    }
                } else {
                    this.triggerTakeSnapshot();
                }
            } finally {
                this.updateProcessingActivity();
            }
        }
    }

    // Phase 2: apply the document to database
    protected applyToDatabase(doc: PouchDB.Core.ExistingDocument<AnyEntry>) {
        return this.withCounting(async () => {
            let releaser: Awaited<ReturnType<typeof this._semaphore.acquire>> | undefined = undefined;
            try {
                const semaphore = (await this.isLargeDocument(doc)) ? this._largeDocumentSemaphore : this._semaphore;
                releaser = await semaphore.acquire();
                await this._applyToDatabase(doc);
            } catch (e) {
                const alreadyWaiting = this._waitingChanges.get(doc._id)?._rev === doc._rev;
                this.log(
                    `Error while processing replication result`,
                    alreadyWaiting ? LOG_LEVEL_VERBOSE : LOG_LEVEL_NOTICE
                );
                this.logError(e);
            } finally {
                // Remove from processing queue (To remove from "in-progress" list, and snapshot will not include it)
                if (releaser) {
                    releaser();
                }
            }
        }, this.services.replication.databaseQueueCount);
    }
    // Phase 2.1: process the document and apply to storage
    // This function is serialized per document to avoid race-condition for the same document.
    private _applyToDatabase(doc_: PouchDB.Core.ExistingDocument<AnyEntry>) {
        const dbDoc = doc_ as LoadedEntry; // It has no `data`
        const path = this.getPath(dbDoc);
        return serialized(`replication-process:${dbDoc._id}`, async () => {
            const docNote = `${path} (${shortenId(dbDoc._id)}, ${shortenRev(dbDoc._rev)})`;
            const requirement = await this.checkChangeRequirement(dbDoc);
            if (requirement === "superseded") {
                this.log(`Skipped (Not latest): ${docNote}`, LOG_LEVEL_VERBOSE);
                this.stopWaiting(dbDoc);
                return;
            }
            if (requirement === "unknown") {
                // A failed check says nothing about whether the revision is still the latest.
                this.keepWaiting(doc_, `Could not check whether ${docNote} is the latest revision`);
                return;
            }
            const isDeleted = dbDoc._deleted === true || ("deleted" in dbDoc && dbDoc.deleted === true);
            const canWait = requirement !== "missing" || isDeleted;
            // Missing content cannot be recovered, but a deletion can still remove the local file.
            if (!canWait) this.stopWaiting(dbDoc);
            // If `Read chunks online` is disabled, chunks should be transferred before here.
            // However, in some cases, chunks are after that. So, if missing chunks exist, we have to wait for them.
            // (If `Use Only Local Chunks` is enabled, we should not attempt to fetch chunks online automatically).

            // Gather full document if not deleted
            const doc = isDeleted ? { ...dbDoc, data: "" } : await this.gatherContent(dbDoc);
            if (!doc) {
                // Usually its chunks have not arrived, and nothing is receiving them now.
                if (requirement === "missing") {
                    this.log(`Failed to gather content of ${docNote}, which no longer exists`, LOG_LEVEL_VERBOSE);
                } else if ((await this.checkChangeRequirement(dbDoc)) === "superseded") {
                    // A later revision was stored while the content was gathered. Often it is the deletion of a
                    // file whose content is no longer in the remote, which a device that was away receives after
                    // the file itself. Nothing is missing then, so the document stops waiting without a notice.
                    this.log(`Skipped (No longer latest): ${docNote}`, LOG_LEVEL_VERBOSE);
                    this.stopWaiting(dbDoc);
                } else {
                    this.keepWaiting(doc_, `Failed to gather content of ${docNote}`, true);
                }
                return;
            }
            // A waiting document stops waiting only once it has been written or can never be, so a failed write is
            // tried again.
            let settled: boolean;
            // Check if other processor wants to process this document, if so, skip processing here.
            if (await this.services.replication.processOptionalSynchroniseResult(dbDoc)) {
                // Already processed
                this.log(`Processed by other processor: ${docNote}`, LOG_LEVEL_DEBUG);
                settled = true;
            } else if (this.services.vault.isValidPath(this.getPath(doc))) {
                // Apply to storage if the path is valid
                try {
                    settled = await this.applyToStorage(doc as MetaEntry);
                } catch (e) {
                    if (canWait) this.keepWaiting(doc_, `Failed to apply ${docNote} to storage`);
                    throw e;
                }
                this.log(`Processed: ${docNote}`, LOG_LEVEL_DEBUG);
            } else {
                // Should process, but have an invalid path
                this.log(`Unprocessed (Invalid path): ${docNote}`, LOG_LEVEL_VERBOSE);
                settled = true;
            }
            if (settled) this.stopWaiting(dbDoc);
            else if (canWait) this.keepWaiting(doc_, `Failed to apply ${docNote} to storage`);
            return;
        });
    }

    /**
     * Gather what applying a document needs, or false while its chunks are not all available.
     *
     * A large binary document which can be written in parts is only checked, without holding its content, and its
     * metadata is applied; the file handler then writes it in parts. Other documents are loaded whole.
     * A failed load is logged quietly here, because the caller reports it once.
     *
     * Chunks which a running replication is delivering are waited for, unless the replicator puts content off:
     * large chunks then arrive after the documents, possibly several synchronisations later, and a document which
     * waited for them here would keep its place among the documents applied at once, holding back notes queued
     * behind it. It goes to the waiting list at once instead.
     */
    private async gatherContent(dbDoc: LoadedEntry): Promise<LoadedEntry | false> {
        const waitForChunks = !this.isContentStillToCome();
        if (isAnyNote(dbDoc) && (dbDoc.size ?? 0) >= LARGE_FILE_BYTES) {
            const availability = await this.localDatabase.inspectDBEntryBinaryContent(dbDoc, waitForChunks);
            if (availability === "streamable") return { ...dbDoc, data: "" };
            if (availability === "missing") return false;
        }
        return await this.localDatabase.getDBEntryFromMeta({ ...dbDoc }, false, waitForChunks, LOG_LEVEL_VERBOSE);
    }

    /**
     * Phase 3: Apply the given entry to storage.
     * @param entry
     * @returns Whether the entry was applied to storage
     */
    protected applyToStorage(entry: MetaEntry): Promise<boolean> {
        return this.withCounting(async () => {
            return await this.services.replication.processSynchroniseResult(entry);
        }, this.services.replication.storageApplyingCount);
    }

    /**
     * Check whether processing is required for the given document.
     * @param dbDoc Document to check
     * @returns `required` when it has to be processed; `superseded` when a later revision has already been processed;
     *     `missing` when the document no longer exists locally, which is still processed but waits only for failed
     *     deletion writes; `unknown` when the check failed
     */
    protected async checkChangeRequirement(
        dbDoc: LoadedEntry
    ): Promise<"required" | "superseded" | "missing" | "unknown"> {
        const path = this.getPath(dbDoc);
        try {
            const savedDoc = await this.localDatabase.getRaw<LoadedEntry>(dbDoc._id, {
                conflicts: true,
                revs_info: true,
            });
            const newRev = dbDoc._rev ?? "";
            const latestRev = savedDoc._rev ?? "";
            const revisions = savedDoc._revs_info?.map((e) => e.rev) ?? [];
            if (savedDoc._conflicts && savedDoc._conflicts.length > 0) {
                // There are conflicts, so we have to process it.
                // (May auto-resolve or user intervention will be occurred).
                return "required";
            }
            if (newRev == latestRev) {
                // The latest revision. Simply we can process it.
                return "required";
            }
            const index = revisions.indexOf(newRev);
            if (index >= 0) {
                // The revision has been inserted before.
                return "superseded"; // This means that the document already processed (While no conflict existed).
            }
            return "required"; // This mostly should not happen, but we have to process it just in case.
        } catch (e) {
            if (isNotFoundError(e)) {
                // getRaw failed due to not existing, it may not be happened normally especially on replication.
                // If the process caused by some other reason, we **probably** have to process it.
                // Note that this is not a common case.
                return "missing";
            } else {
                this.log(
                    `Failed to get existing document for ${path} (${shortenId(dbDoc._id)}, ${shortenRev(dbDoc._rev)}) `,
                    LOG_LEVEL_VERBOSE
                );
                this.logError(e);
                return "unknown";
            }
        }
    }
}
