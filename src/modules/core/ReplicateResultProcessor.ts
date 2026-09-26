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
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";

const KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT = "replicationResultProcessorSnapshot";
const REPROCESS_BATCH_SIZE = 100;
type LocalApplicationActivityOwner = {
    runBoundedLocalApplicationActivity<T>(task: () => T | PromiseLike<T>, options?: { label?: string }): Promise<T>;
};
type ReplicateResultProcessorState = {
    queued: PouchDB.Core.ExistingDocument<EntryDoc>[];
    processing: PouchDB.Core.ExistingDocument<EntryDoc>[];
    /** Documents whose content could not be gathered yet. Snapshots of earlier versions do not have it. */
    waiting?: PouchDB.Core.ExistingDocument<EntryDoc>[];
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
    /**
     * Continue processing which was held back while the application was not ready.
     * An explicit suspension remains in effect.
     */
    public resumeAfterApplicationReady() {
        this.updateProcessingActivity();
        this.triggerProcessQueue();
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
        const snapshot = {
            queued: this._queuedChanges.slice(),
            processing: this._processingChanges.slice(),
            waiting: [...this._waitingChanges.values()],
        } satisfies ReplicateResultProcessorState;
        await this.core.kvDB.set(KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT, snapshot);
        this.log(
            `Snapshot taken. Queued: ${snapshot.queued.length}, Processing: ${snapshot.processing.length}, Waiting: ${snapshot.waiting.length}`,
            LOG_LEVEL_DEBUG
        );
        this.reportStatus();
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
        const snapshot = await this.core.kvDB.get<ReplicateResultProcessorState>(
            KV_KEY_REPLICATION_RESULT_PROCESSOR_SNAPSHOT
        );
        // What the previous run left is part of this run's state from here on, so snapshots may replace it.
        this._snapshotRestored = true;
        if (snapshot) {
            // Documents which waited for their content go on waiting, and are tried again before the next synchronisation.
            const waiting = snapshot.waiting ?? [];
            for (const doc of waiting) {
                if (!this._waitingChanges.has(doc._id)) this._waitingChanges.set(doc._id, doc);
            }
            // Restoring the snapshot re-runs processing for both queued and processing items.
            const newQueue = [...snapshot.processing, ...snapshot.queued, ...this._queuedChanges];
            this._queuedChanges = [];
            this.enqueueAll(newQueue);
            this.log(
                `Restored from snapshot (${snapshot.processing.length + snapshot.queued.length} items, ${waiting.length} waiting for their content)`,
                LOG_LEVEL_INFO
            );
            // await this._takeSnapshot();
        }
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
            this._queuedChanges.length + this._processingChanges.length;
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
        let count = 0;
        let batch: PouchDB.Core.ExistingDocument<EntryDoc>[] = [];
        for await (const document of this.localDatabase.findAllNormalDocs()) {
            batch.push(document);
            count++;
            if (batch.length < REPROCESS_BATCH_SIZE) continue;
            this.enqueueAll(batch);
            batch = [];
        }
        if (batch.length > 0) this.enqueueAll(batch);
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
     * Queue of changes to be processed.
     */
    private _queuedChanges: PouchDB.Core.ExistingDocument<EntryDoc>[] = [];

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
        const busy = new Set([...this._queuedChanges, ...this._processingChanges].map((doc) => doc._id));
        const waiting = [...this._waitingChanges.values()].filter((doc) => !busy.has(doc._id));
        if (waiting.length === 0) return;
        this.log(`Trying ${waiting.length} document(s) again which could not be applied yet`, LOG_LEVEL_INFO);
        this.enqueueAll(waiting);
    }

    /**
     * Keep a document which could not be applied, to try it again before the next synchronisation.
     *
     * Only the first failure of a revision is a notice; its repeats are logged quietly.
     */
    private keepWaiting(doc: PouchDB.Core.ExistingDocument<EntryDoc>, reason: string) {
        const alreadyWaiting = this._waitingChanges.get(doc._id)?._rev === doc._rev;
        this._waitingChanges.set(doc._id, doc);
        this.log(
            `${reason}; it is tried again before the next synchronisation`,
            alreadyWaiting ? LOG_LEVEL_VERBOSE : LOG_LEVEL_NOTICE
        );
        this.triggerTakeSnapshot();
    }

    /** Stop waiting for a document once its waiting revision has been written, replaced, or cannot be applied at all. */
    private stopWaiting(doc: { _id: string; _rev?: string }) {
        if (this._waitingChanges.get(doc._id)?._rev !== doc._rev) return;
        this._waitingChanges.delete(doc._id);
        this.triggerTakeSnapshot();
    }

    private _processingActivity?: Promise<void>;
    private _processingActivityDone?: PromiseWithResolvers<void>;

    private updateProcessingActivity() {
        if (this.isSuspended) {
            this._processingActivityDone?.resolve();
            return;
        }
        const hasPendingDocuments = this._queuedChanges.length > 0 || this._processingChanges.length > 0;
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
        const old = this._queuedChanges.find((e) => e._id == doc._id);
        const path = "path" in doc ? this.getPath(doc) : "<unknown>";
        const docNote = `${path} (${shortenId(doc._id)}, ${shortenRev(doc._rev)})`;
        if (old) {
            if (old._rev == doc._rev) {
                this.log(`[Enqueue] skipped (Already queued): ${docNote}`, LOG_LEVEL_VERBOSE);
                return;
            }

            const oldRev = old._rev ?? "";
            const isDeletedBefore = old._deleted === true || ("deleted" in old && old.deleted === true);
            const isDeletedNow = doc._deleted === true || ("deleted" in doc && doc.deleted === true);

            // Replace the old queued change (This may performed batched updates, actually process performed always with the latest version, hence we can simply replace it if the change is the same type).
            if (isDeletedBefore === isDeletedNow) {
                this._queuedChanges = this._queuedChanges.filter((e) => e._id != doc._id);
                this.log(`[Enqueue] requeued: ${docNote} (from rev: ${shortenRev(oldRev)})`, LOG_LEVEL_VERBOSE);
            }
        }
        // Enqueue the change
        this._queuedChanges.push(doc);
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
        if (this._queuedChanges.length == 0) return;
        try {
            this._isRunningProcessQueue = true;
            while (this._queuedChanges.length > 0) {
                // If getting suspended, bail the loop. Some concurrent tasks may still be running.
                if (this.isSuspended) {
                    this.log(
                        `Processing has got suspended. Remaining items in queue: ${this._queuedChanges.length}`,
                        LOG_LEVEL_INFO
                    );
                    break;
                }

                // Acquire semaphore for new processing slot
                // (per-document serialisation caps concurrency).
                const releaser = await this._semaphore.acquire();
                releaser();
                // Dequeue the next change
                const doc = this._queuedChanges.shift();
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
                if (this._queuedChanges.length === 0 && this._processingChanges.length === 0) {
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
                this.log(`Error while processing replication result`, LOG_LEVEL_NOTICE);
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
            // A document which no longer exists locally cannot be completed later, so it does not wait.
            if (requirement === "missing") this.stopWaiting(dbDoc);
            // If `Read chunks online` is disabled, chunks should be transferred before here.
            // However, in some cases, chunks are after that. So, if missing chunks exist, we have to wait for them.
            // (If `Use Only Local Chunks` is enabled, we should not attempt to fetch chunks online automatically).

            const isDeleted = dbDoc._deleted === true || ("deleted" in dbDoc && dbDoc.deleted === true);
            // Gather full document if not deleted
            const doc = isDeleted ? { ...dbDoc, data: "" } : await this.gatherContent(dbDoc);
            if (!doc) {
                // Usually its chunks have not arrived, and nothing is receiving them now.
                if (requirement === "missing") {
                    this.log(`Failed to gather content of ${docNote}, which no longer exists`, LOG_LEVEL_VERBOSE);
                } else {
                    this.keepWaiting(doc_, `Failed to gather content of ${docNote}`);
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
                settled = await this.applyToStorage(doc as MetaEntry);
                this.log(`Processed: ${docNote}`, LOG_LEVEL_DEBUG);
            } else {
                // Should process, but have an invalid path
                this.log(`Unprocessed (Invalid path): ${docNote}`, LOG_LEVEL_VERBOSE);
                settled = true;
            }
            if (settled) this.stopWaiting(dbDoc);
            return;
        });
    }

    /**
     * Gather what applying a document needs, or false while its chunks are not all available.
     *
     * A large binary document which can be written in parts is only checked, without holding its content, and its
     * metadata is applied; the file handler then writes it in parts. Other documents are loaded whole, as before.
     * A failed load is logged quietly here, because the caller reports it once.
     */
    private async gatherContent(dbDoc: LoadedEntry): Promise<LoadedEntry | false> {
        if (isAnyNote(dbDoc) && (dbDoc.size ?? 0) >= LARGE_FILE_BYTES) {
            const availability = await this.localDatabase.inspectDBEntryBinaryContent(dbDoc, true);
            if (availability === "streamable") return { ...dbDoc, data: "" };
            if (availability === "missing") return false;
        }
        return await this.localDatabase.getDBEntryFromMeta({ ...dbDoc }, false, true, LOG_LEVEL_VERBOSE);
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
     *     `missing` when the document no longer exists locally, which is processed as before; `unknown` when the check
     *     failed
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
