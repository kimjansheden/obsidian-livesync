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

const KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT = "replicationResultProcessorSnapshot";
const REPROCESS_BATCH_SIZE = 100;
/** The key which holds how far the reprocessing of a changed filter has come, so a restart continues from there. */
const KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION = "replicationResultProcessorReprocessPosition";
/**
 * While no more documents than this wait to be processed, the whole queue is written as one record, in the exact
 * shape an earlier release wrote (no `overflow` field). The value sits far above an ordinary replication batch and
 * above the reprocessing bound below, so the common case keeps that single record: an earlier release reads and
 * writes it unchanged, which makes both upgrade and downgrade trivial there. Above it the queue is paged, and the
 * write for one change stays bounded by this record plus one page, whatever the length of the queue.
 */
export const SNAPSHOT_INLINE_LIMIT = 1000;
/** How many documents one overflow page holds. */
export const SNAPSHOT_PAGE_SIZE = 1000;
/** How many documents are enqueued from a stored queue before yielding to the event loop while restoring. */
export const RESTORE_SLICE_SIZE = 1000;
/** The most documents the reprocessing of a changed filter keeps queued at once, so the queue stays bounded. */
export const REPROCESS_QUEUE_LIMIT = 1000;
/** How long the reprocessing waits between checks while the queue drains below its bound. */
const REPROCESS_DRAIN_POLL_MS = 50;

/** The small part of the key-value database this processor uses. `del` is absent on some hosts, so it is optional. */
type SnapshotStore = {
    get<T>(key: string): Promise<T>;
    set(key: string, value: unknown): Promise<unknown>;
    del?(key: string): Promise<void>;
};
type QueueDoc = PouchDB.Core.ExistingDocument<EntryDoc>;
/** A contiguous range of overflow page numbers. */
type OverflowRange = { fromPage: number; toPage: number };
/** Thrown to end the filter reprocessing while the processor is suspended; the pass resumes on {@link ReplicateResultProcessor.resume}. */
class ReprocessSuspended extends Error {}

/**
 * A first-in-first-out queue of documents, de-duplicated by id, with O(1) enqueue, replace and dequeue.
 *
 * An index from id to the slot which holds the document means adding or replacing one never scans the queue.
 * A removed or replaced slot becomes a hole which the queue skips; a head page of only consumed slots is dropped.
 * The documents are grouped into fixed-size pages with stable numbers, so that what must be written to survive a
 * restart can be limited to the pages which changed.
 */
class PagedDocumentQueue {
    /** pages[0] is the head. Each page holds up to `pageSize` slots; a consumed or removed slot holds undefined. */
    private readonly pages: (QueueDoc | undefined)[][] = [];
    /** The number of pages[0]. It only rises, as drained head pages are dropped, so a page keeps its number for life. */
    private basePage = 0;
    private readonly index = new Map<string, { page: number; slot: number }>();
    /** The next slot to take from, within pages[0]. */
    private headSlot = 0;
    private _size = 0;
    /** Overflow pages (number >= basePage + 1) whose content changed since the last {@link drainChangedPages}. */
    private readonly changedOverflow = new Set<number>();

    constructor(private readonly pageSize: number) {}

    get size(): number {
        return this._size;
    }

    get(id: string): QueueDoc | undefined {
        const at = this.index.get(id);
        return at ? this.pages[at.page - this.basePage][at.slot] : undefined;
    }

    /** Append a document, moving it to the end when it is already queued (its earlier slot becomes a hole). */
    enqueue(doc: QueueDoc): void {
        this.delete(doc._id);
        let tail = this.pages[this.pages.length - 1];
        if (tail === undefined || tail.length >= this.pageSize) {
            tail = [];
            this.pages.push(tail);
        }
        const page = this.basePage + this.pages.length - 1;
        this.index.set(doc._id, { page, slot: tail.length });
        tail.push(doc);
        this._size++;
        if (page > this.basePage) this.changedOverflow.add(page);
    }

    /** Remove a document by its id, if it is queued. */
    delete(id: string): void {
        const at = this.index.get(id);
        if (!at) return;
        this.pages[at.page - this.basePage][at.slot] = undefined;
        this.index.delete(id);
        this._size--;
        if (at.page > this.basePage) this.changedOverflow.add(at.page);
    }

    /** Take the document at the head, skipping holes, or undefined when the queue is empty. */
    dequeue(): QueueDoc | undefined {
        while (this.pages.length > 0) {
            const head = this.pages[0];
            while (this.headSlot < head.length) {
                const doc = head[this.headSlot];
                this.headSlot++;
                if (doc === undefined) continue;
                this.index.delete(doc._id);
                this._size--;
                if (this.headSlot >= head.length) this.dropHeadPage();
                return doc;
            }
            this.dropHeadPage();
        }
        return undefined;
    }

    private dropHeadPage(): void {
        this.pages.shift();
        this.basePage++;
        this.headSlot = 0;
        // The page which is now at the head, if any, has left the overflow; a later snapshot stops naming its key.
        if (this.pages.length > 0) this.changedOverflow.delete(this.basePage);
    }

    /** The live documents in order, from the head. */
    *values(): IterableIterator<QueueDoc> {
        for (let i = 0; i < this.pages.length; i++) {
            const from = i === 0 ? this.headSlot : 0;
            const page = this.pages[i];
            for (let slot = from; slot < page.length; slot++) {
                const doc = page[slot];
                if (doc !== undefined) yield doc;
            }
        }
    }

    /** The live documents of the head page, which the base record holds while the queue is paged. */
    headDocs(): QueueDoc[] {
        if (this.pages.length === 0) return [];
        return this.pages[0].slice(this.headSlot).filter((doc): doc is QueueDoc => doc !== undefined);
    }

    /** The range of overflow page numbers, or undefined when the whole queue fits in the head page. */
    overflowRange(): OverflowRange | undefined {
        if (this.pages.length <= 1) return undefined;
        return { fromPage: this.basePage + 1, toPage: this.basePage + this.pages.length - 1 };
    }

    /** The live documents of one overflow page. */
    overflowPage(page: number): QueueDoc[] {
        return this.pages[page - this.basePage].filter((doc): doc is QueueDoc => doc !== undefined);
    }

    /**
     * The overflow pages whose content changed since the last call, by number, clearing the record. A snapshot
     * rewrites exactly these under fresh keys; pages it does not name here keep the key an earlier snapshot wrote.
     */
    drainChangedPages(): number[] {
        const changed = [...this.changedOverflow];
        this.changedOverflow.clear();
        return changed;
    }
}

type ReplicateResultProcessorState = {
    queued: QueueDoc[];
    processing: QueueDoc[];
    /** Documents whose content could not be gathered yet. Snapshots of earlier versions do not have it. */
    waiting?: QueueDoc[];
    /**
     * The IDs of the waiting documents whose missing content has not been reported with a notice yet, because it
     * was still to come. Snapshots of earlier versions do not have it.
     */
    waitingWithoutNotice?: string[];
    /**
     * Present only when the queue did not fit in this one record. It names, in queue order, the keys which hold the
     * documents past the head page, one page each. Each key carries the generation that last wrote its page, so a
     * rewrite takes a new key and never overwrites one this record still names. Absent within the inline limit, so
     * an earlier release reads the record exactly as before and simply ignores the field it does not know.
     */
    overflow?: string[];
};
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
            this._reprocessInterrupted = false;
            fireAndForget(() => this.reprocessStoredDocuments());
        }
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
        // Serialise the whole body so the throttled fire-and-forget and the awaited call in the processing
        // `finally` cannot interleave page and base writes, which the crash-safe order below depends on.
        await serialized(KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT, () => this._writeSnapshot());
    }

    private async _writeSnapshot() {
        const store = this.core.kvDB as unknown as SnapshotStore;
        const processing = this._processingChanges.slice();
        const waiting = [...this._waitingChanges.values()];
        const waitingWithoutNotice = [...this._waitingWithoutNotice];
        const baseKey = KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT;
        if (this._queuedChanges.size <= SNAPSHOT_INLINE_LIMIT) {
            // The common case: the whole queue fits one record, written in the exact shape an earlier release reads.
            const snapshot = {
                queued: [...this._queuedChanges.values()],
                processing,
                waiting,
                waitingWithoutNotice,
            } satisfies ReplicateResultProcessorState;
            await store.set(baseKey, snapshot);
            // The base now holds the whole queue, so the overflow keys the previous base named are unreferenced.
            const staleKeys = this._storedOverflowKeys;
            this._storedOverflowKeys = [];
            this._overflowKeys.clear();
            await this._deleteOverflowKeys(store, staleKeys);
            this.log(
                `Snapshot taken. Queued: ${snapshot.queued.length}, Processing: ${processing.length}, Waiting: ${waiting.length}`,
                LOG_LEVEL_DEBUG
            );
            this.reportStatus();
            return;
        }
        // Above the limit: the head page stays in the base record, the rest is paged under per-page keys the base
        // names. The base record is the single commit point. Each page whose content changed this interval is
        // written under a fresh-generation key, never overwriting a key the committed base still names; an unchanged
        // page keeps the key an earlier generation wrote it under. The base then commits naming the exact current
        // set of keys, and only afterwards are the keys the previous base named but the new one does not (superseded
        // pages, and pages which left the overflow) deleted. So some committed base names a key for every live id at
        // every crash point: before the flip, the old base and its still-present keys; after it, the new base and
        // the fresh keys written before it. A page which is both the source and the destination of a moved id is
        // simply rewritten under one fresh key with its final content, so no page needs a before/after split and a
        // move can duplicate an id but never lose it.
        //
        // Take one consistent cut synchronously, before the first await. serialized() blocks another snapshot but
        // not enqueue/dequeue, which runProcessQueue performs between its own awaits, so reading the queue after an
        // await could persist a base which no longer names head documents a concurrent dequeue just removed. Every
        // value the writes persist is materialised here into plain arrays.
        const headDocs = this._queuedChanges.headDocs();
        const range = this._queuedChanges.overflowRange();
        const currentPages: number[] = [];
        if (range) for (let n = range.fromPage; n <= range.toPage; n++) currentPages.push(n);
        const currentPageSet = new Set(currentPages);
        const changed = new Set(this._queuedChanges.drainChangedPages());
        const generation = ++this._snapshotGeneration;
        const newKeys = new Map(this._overflowKeys);
        const toWrite: { key: string; docs: QueueDoc[] }[] = [];
        for (const n of currentPages) {
            // A page is rewritten when its content changed, or when no key holds it yet (the first paged snapshot,
            // or the first after a restore); an unchanged page keeps the key an earlier generation wrote it under.
            if (changed.has(n) || !newKeys.has(n)) {
                const key = this._overflowPageKey(generation, n);
                newKeys.set(n, key);
                toWrite.push({ key, docs: this._queuedChanges.overflowPage(n) });
            }
        }
        // Drop the keys of pages which are no longer part of the overflow, so the base names only current pages.
        for (const n of [...newKeys.keys()]) if (!currentPageSet.has(n)) newKeys.delete(n);
        const overflow = currentPages.map((n) => newKeys.get(n)!);
        const snapshot = {
            queued: headDocs,
            processing,
            waiting,
            waitingWithoutNotice,
            overflow,
        } satisfies ReplicateResultProcessorState;
        // From here only the captured values are used; the queue is never read again across an await.
        for (const page of toWrite) await store.set(page.key, page.docs);
        await store.set(baseKey, snapshot);
        const named = new Set(overflow);
        const stale = this._storedOverflowKeys.filter((key) => !named.has(key));
        this._overflowKeys = newKeys;
        this._storedOverflowKeys = overflow;
        await this._deleteOverflowKeys(store, stale);
        this.log(
            `Snapshot taken (paged). Head: ${snapshot.queued.length}, Overflow pages: ${overflow.length}, Processing: ${processing.length}, Waiting: ${waiting.length}`,
            LOG_LEVEL_DEBUG
        );
        this.reportStatus();
    }

    /**
     * The key under which overflow page `n` is stored at generation `gen`. A page keeps its number but takes a
     * fresh key each time it is rewritten, so a write never overwrites a key a committed base still names.
     */
    private _overflowPageKey(gen: number, n: number): string {
        return `${KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT}:q:${gen}:${n}`;
    }
    /** The generation encoded in an overflow key, or -1 when it does not parse, to continue past the stored keys. */
    private _overflowKeyGeneration(key: string): number {
        const parts = key.split(":");
        const gen = Number(parts[parts.length - 2]);
        return Number.isFinite(gen) ? gen : -1;
    }
    /** Remove overflow keys no base still names, best effort; a host without `del` keeps them, which readers ignore. */
    private async _deleteOverflowKeys(store: SnapshotStore, keys: Iterable<string>): Promise<void> {
        if (!store.del) return;
        for (const key of keys) await store.del(key);
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
        const snapshot = await store.get<ReplicateResultProcessorState>(KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT);
        // What the previous run left is part of this run's state from here on, so snapshots may replace it.
        this._snapshotRestored = true;
        if (!snapshot) return;
        // Documents which waited for their content go on waiting, and are tried again before the next synchronisation.
        const waiting = snapshot.waiting ?? [];
        // A snapshot of an earlier version names none, as it gave every notice at once.
        const waitingWithoutNotice = new Set(snapshot.waitingWithoutNotice);
        for (const doc of waiting) {
            if (this._waitingChanges.has(doc._id)) continue;
            this._waitingChanges.set(doc._id, doc);
            // The notice which was held back for it is still due when its content turns out not to come.
            if (waitingWithoutNotice.has(doc._id)) this._waitingWithoutNotice.add(doc._id);
        }
        // The overflow keys the record names hold the queued documents past the head page, in order.
        const overflow: QueueDoc[] = [];
        const storedKeys = Array.isArray(snapshot.overflow) ? snapshot.overflow : [];
        for (const key of storedKeys) {
            const page = await store.get<QueueDoc[] | undefined>(key);
            if (page) overflow.push(...page);
        }
        // Keep those keys on disk until the next snapshot commits a base of fresh keys; continue the generation past
        // every stored key so a rewrite cannot reuse one of them before the new base stops naming it.
        this._storedOverflowKeys = storedKeys;
        this._overflowKeys.clear();
        for (const key of storedKeys) {
            this._snapshotGeneration = Math.max(this._snapshotGeneration, this._overflowKeyGeneration(key) + 1);
        }
        // Restoring re-runs processing for the processing items, the queued ones, and the overflow, before what
        // was enqueued meanwhile. Enqueueing is O(1) per document, and runs in slices so a large queue does not
        // block the event loop: a single stretch is at most RESTORE_SLICE_SIZE documents.
        const carried = [...this._queuedChanges.values()];
        this._queuedChanges = new PagedDocumentQueue(SNAPSHOT_PAGE_SIZE);
        const toQueue = [...snapshot.processing, ...(snapshot.queued ?? []), ...overflow, ...carried];
        for (let from = 0; from < toQueue.length; from += RESTORE_SLICE_SIZE) {
            this.enqueueAll(toQueue.slice(from, from + RESTORE_SLICE_SIZE));
            if (from + RESTORE_SLICE_SIZE < toQueue.length) await delay(0);
        }
        this.log(
            `Restored from snapshot (${toQueue.length - carried.length} items, ${waiting.length} waiting for their content)`,
            LOG_LEVEL_INFO
        );
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
    public async reprocessStoredDocuments(): Promise<number> {
        const store = this.core.kvDB as unknown as SnapshotStore | undefined;
        // A run interrupted by a restart left how far it had come; this one continues after that id, so no stored
        // document is processed twice and none is left out. The documents stream a page at a time, so the memory in
        // use does not grow with how many are stored.
        const resumeFrom = store ? ((await store.get<string>(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION)) ?? "") : "";
        let count = 0;
        let position = resumeFrom;
        let batch: PouchDB.Core.ExistingDocument<EntryDoc>[] = [];
        const flush = async () => {
            if (batch.length === 0) return;
            this.enqueueAll(batch);
            batch = [];
            // The position is stored only once the batch is queued, so what is on disk never runs ahead of it.
            if (store) await store.set(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION, position);
            // Keep the queue bounded: wait for it to drain below the limit before more is read and queued. A
            // suspended processor never drains, so stop the pass instead of spinning; it resumes from the stored
            // position when the processor resumes, which also lets the database cursor close.
            while (this._queuedChanges.size + this._processingChanges.length >= REPROCESS_QUEUE_LIMIT) {
                if (this.isSuspended) {
                    this._reprocessInterrupted = true;
                    throw new ReprocessSuspended();
                }
                this.triggerProcessQueue();
                await delay(REPROCESS_DRAIN_POLL_MS);
            }
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
                return count;
            }
            throw error;
        }
        // Only a pass which read the whole database clears the position.
        if (store) await store.del?.(KV_KEY_REPLICATION_RESULT_REPROCESS_POSITION);
        this.log(`Requeued ${count} stored document(s) after the reflection filters changed`, LOG_LEVEL_INFO);
        return count;
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
     * Queue of changes to be processed, de-duplicated by id, with O(1) enqueue, replace and dequeue, and written
     * in pages when it grows past {@link SNAPSHOT_INLINE_LIMIT}.
     */
    private _queuedChanges = new PagedDocumentQueue(SNAPSHOT_PAGE_SIZE);
    /** The current storage key of each live overflow page, by page number; a changed page takes a fresh-gen key. */
    private _overflowKeys = new Map<number, string>();
    /** The overflow keys the committed base record names, deleted once a later base names a different set. */
    private _storedOverflowKeys: string[] = [];
    /** Rises each paged snapshot so a rewritten page takes a key no committed base still names; never reused. */
    private _snapshotGeneration = 0;

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
        const busy = new Set([...this._queuedChanges.values(), ...this._processingChanges].map((doc) => doc._id));
        const waiting = [...this._waitingChanges.values()].filter((doc) => !busy.has(doc._id));
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
        this.triggerTakeSnapshot();
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
