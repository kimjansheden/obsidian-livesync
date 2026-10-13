import { promiseWithResolvers } from "octagonal-wheels/promises";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it, vi } from "vitest";
import {
    LARGE_FILE_BYTES,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    REMOTE_COUCHDB,
    REMOTE_MINIO,
    REMOTE_P2P,
    type EntryDoc,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    ReplicateResultProcessor,
    RESTORE_SLICE_SIZE,
    REPROCESS_QUEUE_LIMIT,
    SNAPSHOT_INLINE_LIMIT,
    SNAPSHOT_PAGE_SIZE,
} from "./ReplicateResultProcessor";

function note(id: string): PouchDB.Core.ExistingDocument<EntryDoc> {
    return {
        _id: id,
        _rev: "1-test",
        path: `${id}.md`,
        ctime: 1,
        mtime: 2,
        size: 1,
        children: [],
        datatype: "plain",
        type: "plain",
        eden: {},
    } as unknown as PouchDB.Core.ExistingDocument<EntryDoc>;
}

/** A binary document such as a zip file, of `size` bytes. */
function binaryNote(id: string, size: number, rev = "1-test"): PouchDB.Core.ExistingDocument<EntryDoc> {
    return {
        ...note(id),
        _rev: rev,
        path: `${id}.zip`,
        size,
        datatype: "newnote",
        type: "newnote",
    } as unknown as PouchDB.Core.ExistingDocument<EntryDoc>;
}

type SetupOptions = {
    applicationReady?: boolean;
    databaseReady?: boolean;
    maxMTimeForReflectEvents?: number;
    processSynchroniseResult?: (entry: unknown) => Promise<unknown>;
    setSnapshot?: (key: string, value: unknown) => Promise<unknown>;
    getSnapshot?: (key: string) => Promise<unknown>;
    /** Restore the snapshot of the previous run at once, as the database initialisation does; true when omitted. */
    restore?: boolean;
    /** The type of the remote; left unset when omitted. */
    remoteType?: string;
    /** A full keyed store for the hybrid-snapshot tests; existing tests leave it unset and keep the set/get pair. */
    kv?: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<unknown>;
        del?(key: string): Promise<void>;
    };
};

function setup(options: SetupOptions = {}) {
    const state = {
        /** Whether the chunks of documents have arrived. */
        chunksArrived: true,
        /** Whether the content of a large document with all its chunks can be written in parts. */
        streamable: true,
        /** The latest revision in the database and its history, by document ID; the queued revision when absent. */
        latest: {} as Record<string, string[]>,
        /** How looking up the latest revision fails, when it does. */
        lookupFailure: undefined as "not-found" | "error" | undefined,
        /** Sizes of the local files, by path. */
        localSizes: {} as Record<string, number>,
        isTargetFile: true,
        isFileSizeTooLarge: false,
        isVirtualDocument: false,
        /** Whether the replicator still has content to receive which it put off, such as large chunks. */
        deferredRemoteContent: false,
        /** Whether a replicator is active. */
        hasReplicator: true,
    };
    const settings = {
        maxMTimeForReflectEvents: options.maxMTimeForReflectEvents ?? 0,
        suspendParseReplicationResult: false,
        remoteType: options.remoteType,
    };
    const processSynchroniseResult = vi.fn(options.processSynchroniseResult ?? (async () => true));
    const setSnapshot = vi.fn(options.setSnapshot ?? (async () => undefined));
    const getSnapshot = vi.fn(options.getSnapshot ?? (async () => undefined));
    const runBoundedLocalApplicationActivity = vi.fn(async (task: () => Promise<void>) => await task());
    const lifecycle = { ready: options.applicationReady ?? true, databaseReady: options.databaseReady ?? true };
    const isReady = vi.fn(() => lifecycle.ready);
    const isDatabaseReady = vi.fn(() => lifecycle.databaseReady);
    const getDBEntryFromMeta = vi.fn(async (entry: { _id: string; _rev: string }, ..._options: unknown[]) =>
        state.chunksArrived ? { ...entry, data: "x" } : false
    );
    const inspectDBEntryBinaryContent = vi.fn(async (_entry: unknown, _waitForReady?: boolean) =>
        !state.chunksArrived ? "missing" : state.streamable ? "streamable" : "unsupported"
    );
    const core = {
        services: {
            appLifecycle: { isReady, isSuspended: () => false },
            database: { isDatabaseReady },
            path: { getPath: (entry: { path: string }) => entry.path },
            replication: {
                databaseQueueCount: reactiveSource(0),
                storageApplyingCount: reactiveSource(0),
                replicationResultCount: reactiveSource(0),
                processVirtualDocument: vi.fn(async () => state.isVirtualDocument),
                processOptionalSynchroniseResult: vi.fn(async () => false),
                processSynchroniseResult,
            },
            replicator: {
                runBoundedLocalApplicationActivity,
                peekActiveReplicator: vi.fn(() =>
                    state.hasReplicator ? { hasDeferredRemoteContent: () => state.deferredRemoteContent } : undefined
                ),
            },
            vault: {
                isTargetFile: vi.fn(async () => state.isTargetFile),
                isFileSizeTooLarge: vi.fn(() => state.isFileSizeTooLarge),
                isValidPath: vi.fn(() => true),
            },
        },
        serviceModules: {
            storageAccess: {
                stat: vi.fn(async (path: string) =>
                    path in state.localSizes ? { ctime: 1, mtime: 2, size: state.localSizes[path], type: "file" } : null
                ),
            },
        },
        kvDB: options.kv ?? { set: setSnapshot, get: getSnapshot },
        localDatabase: {
            getRaw: vi.fn(async (id: string) => {
                if (state.lookupFailure === "not-found") throw Object.assign(new Error("missing"), { status: 404 });
                if (state.lookupFailure === "error") throw new Error("the database is busy");
                const history = state.latest[id] ?? ["1-test"];
                return { _id: id, _rev: history[0], _revs_info: history.map((rev) => ({ rev, status: "available" })) };
            }),
            getDBEntryFromMeta,
            inspectDBEntryBinaryContent,
        },
        replicator: { closeReplication: vi.fn() },
    };
    const processor = new ReplicateResultProcessor({ core, settings } as never);
    if (options.restore ?? true) void processor.restoreFromSnapshotOnce();
    const logs = vi.spyOn(processor as unknown as { log: (message: string, level?: number) => void }, "log");
    return {
        state,
        settings,
        isReady,
        lifecycle,
        processor,
        processSynchroniseResult,
        runBoundedLocalApplicationActivity,
        setSnapshot,
        getDBEntryFromMeta,
        inspectDBEntryBinaryContent,
        logs,
    };
}

/** The latest snapshot the processor took. */
function latestSnapshot(setSnapshot: ReturnType<typeof vi.fn>): unknown {
    const calls = setSnapshot.mock.calls;
    return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
}

/** The document IDs waiting in the latest snapshot the processor took. */
function waitingInLatestSnapshot(setSnapshot: ReturnType<typeof vi.fn>): string[] | undefined {
    const snapshot = latestSnapshot(setSnapshot) as { waiting?: { _id: string }[] } | undefined;
    return snapshot?.waiting?.map((doc) => doc._id);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ReplicateResultProcessor", () => {
    it("holds replicated documents while the application is not ready", async () => {
        const { isReady, processor, processSynchroniseResult, runBoundedLocalApplicationActivity } = setup({
            applicationReady: false,
        });

        processor.enqueueAll([note("one")]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(processSynchroniseResult).not.toHaveBeenCalled();
        expect(runBoundedLocalApplicationActivity).not.toHaveBeenCalled();
        expect(processor.isSuspended).toBe(true);
        expect(isReady).toHaveBeenCalled();
    });

    it("applies documents in remediation mode, which never reports readiness", async () => {
        // The limit keeps the application unready by preventing its reconciliation scan.
        const { processor, processSynchroniseResult } = setup({
            applicationReady: false,
            maxMTimeForReflectEvents: Date.parse("2026-09-01T00:00:00Z"),
        });

        expect(processor.isSuspended).toBe(false);
        processor.enqueueAll([note("one")]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("holds documents in remediation mode while the local database is being rebuilt", async () => {
        const { lifecycle, processor, processSynchroniseResult } = setup({
            applicationReady: false,
            databaseReady: false,
            maxMTimeForReflectEvents: Date.parse("2026-09-01T00:00:00Z"),
        });

        expect(processor.isSuspended).toBe(true);
        processor.enqueueAll([note("one")]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        lifecycle.databaseReady = true;
        processor.resumeAfterApplicationReady();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("continues held documents after readiness without lifting an explicit suspension", async () => {
        const { lifecycle, processor, processSynchroniseResult } = setup({ applicationReady: false });
        processor.enqueueAll([note("one")]);
        processor.suspend();

        lifecycle.ready = true;
        processor.resumeAfterApplicationReady();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        processor.resume();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("scans normal-file metadata without loading chunk documents and requeues it", async () => {
        const documents = [
            { _id: "first", _rev: "1-a", type: "plain", path: "first.md" },
            { _id: "second", _rev: "1-b", type: "plain", path: "second.md" },
        ] as unknown as PouchDB.Core.ExistingDocument<EntryDoc>[];
        const findAllNormalDocs = vi.fn(async function* () {
            yield* documents;
        });
        const processor = new ReplicateResultProcessor({
            core: { localDatabase: { findAllNormalDocs } },
        } as never);
        const enqueueAll = vi.spyOn(processor, "enqueueAll").mockImplementation(() => undefined);

        await expect(processor.reprocessStoredDocuments()).resolves.toBe(2);

        expect(findAllNormalDocs).toHaveBeenCalledOnce();
        expect(enqueueAll).toHaveBeenCalledOnce();
        expect(enqueueAll).toHaveBeenCalledWith(documents);
    });

    it("keeps one local application activity until every replicated document has been applied", async () => {
        const applying = promiseWithResolvers<void>();
        let activityFinished = false;
        const { processor, processSynchroniseResult, runBoundedLocalApplicationActivity } = setup({
            processSynchroniseResult: async () => applying.promise,
        });
        runBoundedLocalApplicationActivity.mockImplementation(async (task: () => Promise<void>) => {
            await task();
            activityFinished = true;
        });

        processor.enqueueAll([note("one"), note("two")]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));
        expect(runBoundedLocalApplicationActivity).toHaveBeenCalledTimes(1);
        expect(runBoundedLocalApplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replicated-document-application",
        });
        expect(activityFinished).toBe(false);

        applying.resolve();

        await vi.waitFor(() => expect(activityFinished).toBe(true));
    });

    it("settles local application activity when the final recovery snapshot fails", async () => {
        let activityFinished = false;
        const { processor, runBoundedLocalApplicationActivity } = setup({
            setSnapshot: async () => Promise.reject(new Error("snapshot failed")),
        });
        runBoundedLocalApplicationActivity.mockImplementation(async (task: () => Promise<void>) => {
            await task();
            activityFinished = true;
        });

        processor.enqueueAll([note("one")]);

        await vi.waitFor(() => expect(activityFinished).toBe(true));
    });

    it("releases and reacquires local application activity around processing suspension", async () => {
        const applying = promiseWithResolvers<void>();
        let completedActivities = 0;
        const { processor, processSynchroniseResult, runBoundedLocalApplicationActivity } = setup({
            processSynchroniseResult: async () => applying.promise,
        });
        runBoundedLocalApplicationActivity.mockImplementation(async (task: () => Promise<void>) => {
            await task();
            completedActivities++;
        });
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());

        processor.suspend();
        await vi.waitFor(() => expect(completedActivities).toBe(1));

        processor.resume();
        await vi.waitFor(() => expect(runBoundedLocalApplicationActivity).toHaveBeenCalledTimes(2));

        applying.resolve();
        await vi.waitFor(() => expect(completedActivities).toBe(2));
    });
});

describe("ReplicateResultProcessor with large documents", () => {
    it("treats documents of at least 50 MiB as large", () => {
        expect(LARGE_FILE_BYTES).toBe(50 * 1024 * 1024);
    });

    /**
     * Applies the given documents, holding the first large one until a small one has started beside it. Another
     * large document would start meanwhile if the processor let two run at once.
     */
    async function applyHoldingTheFirstLargeOne(
        documents: PouchDB.Core.ExistingDocument<EntryDoc>[],
        isLarge: (id: string) => boolean,
        prepare: (harness: ReturnType<typeof setup>) => void = () => undefined
    ) {
        const largeStarted = promiseWithResolvers<void>();
        const smallStarted = promiseWithResolvers<void>();
        const counts = { largeRunning: 0, mostLargeRunning: 0, smallBesideLarge: false };
        const harness = setup({
            processSynchroniseResult: async (entry) => {
                if (isLarge((entry as { _id: string })._id)) {
                    counts.largeRunning++;
                    counts.mostLargeRunning = Math.max(counts.mostLargeRunning, counts.largeRunning);
                    largeStarted.resolve();
                    await smallStarted.promise;
                    counts.largeRunning--;
                } else {
                    await largeStarted.promise;
                    if (counts.largeRunning > 0) counts.smallBesideLarge = true;
                    smallStarted.resolve();
                }
                return true;
            },
        });
        prepare(harness);

        harness.processor.enqueueAll(documents);

        await vi.waitFor(() => expect(harness.processSynchroniseResult).toHaveBeenCalledTimes(documents.length));
        await vi.waitFor(() => expect(counts.largeRunning).toBe(0));
        return { ...harness, counts };
    }

    it("applies documents of about 700 MB one at a time, while smaller ones go on beside them", async () => {
        const { counts } = await applyHoldingTheFirstLargeOne(
            [binaryNote("large-1", 700_000_000), binaryNote("large-2", 690_000_000), note("small")],
            (id) => id.startsWith("large")
        );

        expect(counts.mostLargeRunning).toBe(1);
        expect(counts.smallBesideLarge).toBe(true);
    });

    it("counts a document as large when the local file it replaces has about 700 MB", async () => {
        const { counts } = await applyHoldingTheFirstLargeOne(
            [binaryNote("large", 700_000_000), binaryNote("replacing", 1), note("small")],
            (id) => id !== "small",
            ({ state }) => {
                state.localSizes["replacing.zip"] = 700_000_000;
            }
        );

        expect(counts.mostLargeRunning).toBe(1);
        expect(counts.smallBesideLarge).toBe(true);
    });

    it("applies a large document which can be written in parts without loading its content", async () => {
        const { processor, processSynchroniseResult, getDBEntryFromMeta, inspectDBEntryBinaryContent } = setup();
        const document = binaryNote("archive", 700_000_000);

        processor.enqueueAll([document]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(inspectDBEntryBinaryContent).toHaveBeenCalledWith(expect.objectContaining({ _id: "archive" }), true);
        expect(getDBEntryFromMeta).not.toHaveBeenCalled();
        expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "archive", data: "" }));
    });

    it("loads a large document whole when it cannot be written in parts", async () => {
        const { state, processor, processSynchroniseResult, getDBEntryFromMeta } = setup();
        state.streamable = false;

        processor.enqueueAll([binaryNote("legacy", 700_000_000)]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(getDBEntryFromMeta).toHaveBeenCalledOnce();
    });
});

describe("ReplicateResultProcessor with documents which cannot be applied yet", () => {
    it("keeps such a document in its snapshot and applies it when tried again after its content arrived", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot } = setup();
        state.chunksArrived = false;

        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        state.chunksArrived = true;
        processor.retryWaitingChanges();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        processor.retryWaitingChanges();
        await settle();
        expect(processSynchroniseResult).toHaveBeenCalledOnce();
    });

    it("keeps a large document whose chunks are missing waiting without loading it", async () => {
        const { state, processor, processSynchroniseResult, getDBEntryFromMeta, setSnapshot } = setup();
        state.chunksArrived = false;

        processor.enqueueAll([binaryNote("archive", 700_000_000)]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["archive"]));

        state.chunksArrived = true;
        processor.retryWaitingChanges();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(getDBEntryFromMeta).not.toHaveBeenCalled();
    });

    it("tries it again at every synchronisation, with a notice only the first time", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot, getDBEntryFromMeta, logs } = setup();
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        for (let round = 0; round < 3; round++) {
            processor.retryWaitingChanges();
            await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledTimes(round + 2));
        }
        await settle();
        expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]);
        const waitingLogs = logs.mock.calls.filter(([message]) => String(message).includes("Failed to gather content"));
        expect(waitingLogs.map(([, level]) => level)).toEqual([
            LOG_LEVEL_NOTICE,
            LOG_LEVEL_VERBOSE,
            LOG_LEVEL_VERBOSE,
            LOG_LEVEL_VERBOSE,
        ]);
        // The load reports its failure quietly, since the processor reports it once itself.
        for (const call of getDBEntryFromMeta.mock.calls) expect(call[3]).toBe(LOG_LEVEL_VERBOSE);

        state.chunksArrived = true;
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("keeps waiting across a restart, and tries the document again at the next synchronisation", async () => {
        const first = setup();
        first.state.chunksArrived = false;
        first.processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(first.setSnapshot)).toEqual(["one"]));
        const snapshot = latestSnapshot(first.setSnapshot);

        const restarted = setup({ getSnapshot: async () => snapshot });
        await restarted.processor.restoreFromSnapshotOnce();
        await settle();
        expect(restarted.processSynchroniseResult).not.toHaveBeenCalled();

        restarted.processor.retryWaitingChanges();

        await vi.waitFor(() => expect(restarted.processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("stops waiting for a document which a newer revision has replaced", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot } = setup();
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        state.latest.one = ["2-newer", "1-test"];
        processor.retryWaitingChanges();

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        expect(processSynchroniseResult).not.toHaveBeenCalled();
    });

    it.each<[string, (harness: ReturnType<typeof setup>) => void]>([
        [
            "its modification time is beyond the limit",
            ({ settings }) => {
                settings.maxMTimeForReflectEvents = 1;
            },
        ],
        [
            "another processor takes it as a virtual document",
            ({ state }) => {
                state.isVirtualDocument = true;
            },
        ],
        [
            "its path is no longer synchronised",
            ({ state }) => {
                state.isTargetFile = false;
            },
        ],
        [
            "it exceeds the size limit",
            ({ state }) => {
                state.isFileSizeTooLarge = true;
            },
        ],
        [
            "it no longer exists in the local database",
            ({ state }) => {
                state.lookupFailure = "not-found";
            },
        ],
    ])("stops waiting for a document when %s", async (_case, change) => {
        const harness = setup();
        const { state, processor, processSynchroniseResult, setSnapshot } = harness;
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        change(harness);
        processor.retryWaitingChanges();

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        expect(processSynchroniseResult).not.toHaveBeenCalled();
    });

    it("keeps a document waiting when its latest revision cannot be checked", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot } = setup();
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        state.chunksArrived = true;
        state.lookupFailure = "error";
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processor["_processingChanges"]).toHaveLength(0));
        await settle();
        expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]);
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        state.lookupFailure = undefined;
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("keeps a new document waiting when its latest revision cannot be checked", async () => {
        const { state, processor, setSnapshot } = setup();
        state.lookupFailure = "error";

        processor.enqueueAll([note("one")]);

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));
    });

    it("stops waiting only once the document has been written", async () => {
        let writes = 0;
        const { state, processor, processSynchroniseResult, setSnapshot } = setup({
            processSynchroniseResult: async () => ++writes > 1,
        });
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        state.chunksArrived = true;
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        await settle();
        expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]);

        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
    });

    it.each(["returns false", "throws"])("retries a first storage write which %s", async (failure) => {
        let writes = 0;
        const first = setup({
            processSynchroniseResult: async () => {
                if (++writes === 1) {
                    if (failure === "throws") throw new Error("storage is temporarily unavailable");
                    return false;
                }
                return true;
            },
        });
        first.processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(first.processSynchroniseResult).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(waitingInLatestSnapshot(first.setSnapshot)).toEqual(["one"]));

        const restarted = setup({ getSnapshot: async () => latestSnapshot(first.setSnapshot) });
        await restarted.processor.restoreFromSnapshotOnce();
        restarted.processor.retryWaitingChanges();
        await vi.waitFor(() => expect(restarted.processSynchroniseResult).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(waitingInLatestSnapshot(restarted.setSnapshot)).toEqual([]));
    });

    it.each(["returns false", "throws"])(
        "retries a deletion with missing metadata whose storage write %s",
        async (failure) => {
            let writes = 0;
            const first = setup({
                processSynchroniseResult: async () => {
                    if (++writes === 1) {
                        if (failure === "throws") throw new Error("storage is temporarily unavailable");
                        return false;
                    }
                    return true;
                },
            });
            first.state.lookupFailure = "not-found";
            first.processor.enqueueAll([{ ...note("one"), _deleted: true }]);
            await vi.waitFor(() => expect(first.processSynchroniseResult).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(waitingInLatestSnapshot(first.setSnapshot)).toEqual(["one"]));

            const restarted = setup({ getSnapshot: async () => latestSnapshot(first.setSnapshot) });
            restarted.state.lookupFailure = "not-found";
            await restarted.processor.restoreFromSnapshotOnce();
            restarted.processor.retryWaitingChanges();
            await vi.waitFor(() => expect(restarted.processSynchroniseResult).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(waitingInLatestSnapshot(restarted.setSnapshot)).toEqual([]));
        }
    );

    it("does not retry an older revision after its first storage write fails", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot } = setup({
            processSynchroniseResult: async () => false,
        });
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        state.latest.one = ["2-newer", "1-test"];
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        expect(processSynchroniseResult).toHaveBeenCalledOnce();
    });

    it("reports repeated storage exceptions only once as a notice", async () => {
        const { processor, processSynchroniseResult, setSnapshot, logs } = setup({
            processSynchroniseResult: async () => {
                throw new Error("storage is temporarily unavailable");
            },
        });
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));
        await settle();
        const notices = logs.mock.calls.filter(([, level]) => level === LOG_LEVEL_NOTICE);
        expect(notices).toHaveLength(1);
        expect(notices[0][0]).toContain("Failed to apply");
    });

    it("does not queue a waiting document again while it is being processed", async () => {
        const writing = promiseWithResolvers<void>();
        const { state, processor, processSynchroniseResult, setSnapshot } = setup({
            processSynchroniseResult: async () => {
                await writing.promise;
                return true;
            },
        });
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        // The same revision arrives again with its chunks, and is being written when the next round begins.
        state.chunksArrived = true;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        processor.retryWaitingChanges();
        writing.resolve();

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        await settle();
        expect(processSynchroniseResult).toHaveBeenCalledOnce();
    });

    it("does not let a waiting revision replace a newer revision of the same document in the queue", async () => {
        const { state, lifecycle, processor, processSynchroniseResult, setSnapshot } = setup();
        state.chunksArrived = false;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        // A newer revision arrives while documents are held, and the waiting one is tried again meanwhile.
        lifecycle.ready = false;
        state.latest.one = ["2-newer", "1-test"];
        processor.enqueueAll([{ ...note("one"), _rev: "2-newer" } as PouchDB.Core.ExistingDocument<EntryDoc>]);
        processor.retryWaitingChanges();
        state.chunksArrived = true;
        lifecycle.ready = true;
        processor.resumeAfterApplicationReady();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _rev: "2-newer" }));
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        expect(processSynchroniseResult).toHaveBeenCalledOnce();
    });
});

/** What the processor stored about its waiting documents in its latest snapshot. */
function waitingWithoutNoticeInLatestSnapshot(setSnapshot: ReturnType<typeof vi.fn>): string[] | undefined {
    return (latestSnapshot(setSnapshot) as { waitingWithoutNotice?: string[] } | undefined)?.waitingWithoutNotice;
}

describe("ReplicateResultProcessor while the replicator puts large content off", () => {
    const ARCHIVE_BYTES = 700_000_000;
    /** The level of each log which reported that a document was kept waiting for the given reason. */
    const logLevels = (logs: ReturnType<typeof setup>["logs"], reason = "Failed to gather content") =>
        logs.mock.calls.filter(([message]) => String(message).includes(reason)).map(([, level]) => level);

    it("reads without waiting for chunks while content is still to come", async () => {
        const { state, processor, processSynchroniseResult, getDBEntryFromMeta, inspectDBEntryBinaryContent } = setup({
            remoteType: REMOTE_MINIO,
        });
        state.deferredRemoteContent = true;
        processor.enqueueAll([note("one"), binaryNote("archive", ARCHIVE_BYTES)]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));

        expect(getDBEntryFromMeta).toHaveBeenCalledWith(
            expect.objectContaining({ _id: "one" }),
            false,
            false,
            LOG_LEVEL_VERBOSE
        );
        expect(inspectDBEntryBinaryContent).toHaveBeenCalledWith(expect.objectContaining({ _id: "archive" }), false);
    });

    it("loads a large document whole without waiting when it cannot be written in parts", async () => {
        const { state, processor, processSynchroniseResult, getDBEntryFromMeta } = setup({ remoteType: REMOTE_MINIO });
        state.streamable = false;
        state.deferredRemoteContent = true;

        processor.enqueueAll([binaryNote("legacy", ARCHIVE_BYTES)]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(getDBEntryFromMeta.mock.calls[0][2]).toBe(false);
    });

    it.each([
        ["a CouchDB replication", REMOTE_COUCHDB, true],
        ["a peer-to-peer replication", REMOTE_P2P, true],
        // A peer can deliver beside an Object Storage remote which has nothing put off.
        ["a peer-to-peer replication beside an Object Storage remote", REMOTE_MINIO, true],
        ["a replication when no replicator is active", REMOTE_MINIO, false],
    ])("still waits for chunks which %s is delivering", async (_name, remoteType, hasReplicator) => {
        const { state, processor, processSynchroniseResult, getDBEntryFromMeta, inspectDBEntryBinaryContent } = setup({
            remoteType,
        });
        state.hasReplicator = hasReplicator;
        processor.enqueueAll([note("one"), binaryNote("archive", ARCHIVE_BYTES)]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));

        expect(getDBEntryFromMeta).toHaveBeenCalledWith(
            expect.objectContaining({ _id: "one" }),
            false,
            true,
            LOG_LEVEL_VERBOSE
        );
        expect(inspectDBEntryBinaryContent).toHaveBeenCalledWith(expect.objectContaining({ _id: "archive" }), true);
    });

    /**
     * Twelve binary documents whose chunks have not arrived, queued before a note which is complete. A read which
     * waits for chunks stays pending, as it does while a replication which may deliver them is running.
     */
    function queueNoteBehindDocumentsWithoutChunks(remoteType: string, deferredRemoteContent: boolean) {
        const harness = setup({ remoteType });
        harness.state.deferredRemoteContent = deferredRemoteContent;
        const waitingReads: (() => void)[] = [];
        harness.getDBEntryFromMeta.mockImplementation(async (entry: { _id: string; _rev: string }, ...rest) => {
            if (entry._id === "note") return { ...entry, data: "x" };
            if (rest[1] === true) await new Promise<void>((resolve) => waitingReads.push(resolve));
            return false;
        });
        const attachments = Array.from({ length: 12 }, (_, index) => binaryNote(`attachment-${index}`, 1_000_000));
        harness.processor.enqueueAll([...attachments, note("note")]);
        return { ...harness, attachments, waitingReads };
    }

    it("applies a note queued behind documents whose large chunks are still to come", async () => {
        const { processSynchroniseResult, setSnapshot, attachments } = queueNoteBehindDocumentsWithoutChunks(
            REMOTE_MINIO,
            true
        );

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());

        expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "note" }));
        await vi.waitFor(() =>
            expect(waitingInLatestSnapshot(setSnapshot)?.sort()).toEqual(attachments.map((doc) => doc._id).sort())
        );
    });

    it.each([
        ["a CouchDB replication", REMOTE_COUCHDB],
        ["a peer-to-peer replication beside an Object Storage remote", REMOTE_MINIO],
    ])("keeps the places of documents which wait for chunks from %s", async (_name, remoteType) => {
        const { processSynchroniseResult, waitingReads } = queueNoteBehindDocumentsWithoutChunks(remoteType, false);

        // Ten documents are applied at once, and each of them waits for its chunks.
        await vi.waitFor(() => expect(waitingReads).toHaveLength(10));
        await settle();
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        // The replication ends without the chunks, the waiting documents give up their places, and the note follows.
        while (processSynchroniseResult.mock.calls.length === 0) {
            waitingReads.shift()?.();
            await settle();
        }
        expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "note" }));
        // The documents which are still waiting hold a lock by their ID until their read ends.
        while (waitingReads.length > 0) {
            waitingReads.shift()!();
            await settle();
        }
    });

    it("waits without a notice while content is still to come, and gives the notice once nothing more is", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot, getDBEntryFromMeta, logs } = setup();
        state.chunksArrived = false;
        state.deferredRemoteContent = true;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledTimes(2));
        await settle();
        expect(logLevels(logs)).toEqual([LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE]);

        // Everything which was put off has been received, and the chunks of this document were not among it.
        state.deferredRemoteContent = false;
        for (let round = 0; round < 2; round++) {
            processor.retryWaitingChanges();
            await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledTimes(round + 3));
            await settle();
        }
        expect(logLevels(logs)).toEqual([LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE]);
        expect(processSynchroniseResult).not.toHaveBeenCalled();
    });

    it("applies a document without any notice when its chunks arrive while content was still to come", async () => {
        const { state, processor, processSynchroniseResult, setSnapshot, logs } = setup();
        state.chunksArrived = false;
        state.deferredRemoteContent = true;
        processor.enqueueAll([binaryNote("archive", ARCHIVE_BYTES)]);
        await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual(["archive"]));

        state.chunksArrived = true;
        state.deferredRemoteContent = false;
        processor.retryWaitingChanges();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));
        expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
        expect(logs.mock.calls.filter(([, level]) => level === LOG_LEVEL_NOTICE)).toEqual([]);
    });

    it.each([
        ["no content is still to come", true],
        ["no replicator is active", false],
    ])("gives the notice at once when %s", async (_case, hasReplicator) => {
        const { state, processor, setSnapshot, logs } = setup();
        state.chunksArrived = false;
        state.hasReplicator = hasReplicator;

        processor.enqueueAll([note("one")]);

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));
        expect(logLevels(logs)).toEqual([LOG_LEVEL_NOTICE]);
        expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
    });

    it.each<[string, string, (harness: ReturnType<typeof setup>) => void]>([
        [
            "a write to storage fails",
            "Failed to apply",
            ({ processSynchroniseResult }) => {
                processSynchroniseResult.mockResolvedValue(false);
            },
        ],
        [
            "its latest revision cannot be checked",
            "Could not check whether",
            ({ state }) => {
                state.lookupFailure = "error";
            },
        ],
    ])("still gives a notice at once when %s, although content is still to come", async (_case, reason, fail) => {
        const harness = setup();
        const { state, processor, setSnapshot, logs } = harness;
        state.deferredRemoteContent = true;
        fail(harness);

        processor.enqueueAll([note("one")]);

        await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));
        expect(logLevels(logs, reason)).toEqual([LOG_LEVEL_NOTICE]);
        expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
    });

    it.each<[string, string, (harness: ReturnType<typeof setup>) => void]>([
        [
            "the write to storage fails",
            "Failed to apply",
            ({ processSynchroniseResult }) => {
                processSynchroniseResult.mockResolvedValue(false);
            },
        ],
        [
            "the write to storage throws",
            "Failed to apply",
            ({ processSynchroniseResult }) => {
                processSynchroniseResult.mockRejectedValue(new Error("storage is temporarily unavailable"));
            },
        ],
        [
            "its latest revision cannot be checked",
            "Could not check whether",
            ({ state }) => {
                state.lookupFailure = "error";
            },
        ],
    ])(
        "gives the notice which was held back when the content has arrived but %s",
        async (_case, reason, failOtherwise) => {
            const harness = setup();
            const { state, processor, setSnapshot, logs } = harness;
            state.chunksArrived = false;
            state.deferredRemoteContent = true;
            processor.enqueueAll([binaryNote("archive", ARCHIVE_BYTES)]);
            await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual(["archive"]));
            expect(logs.mock.calls.filter(([, level]) => level === LOG_LEVEL_NOTICE)).toEqual([]);

            // Its chunks arrive while more content is still to come, and the document then fails otherwise.
            state.chunksArrived = true;
            failOtherwise(harness);
            for (let round = 1; round <= 2; round++) {
                processor.retryWaitingChanges();
                await vi.waitFor(() => expect(logLevels(logs, reason)).toHaveLength(round));
                await settle();
            }

            // The failure is reported once, although the same revision was already waiting, and then quietly.
            expect(logLevels(logs, reason)).toEqual([LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE]);
            expect(logs.mock.calls.filter(([, level]) => level === LOG_LEVEL_NOTICE)).toHaveLength(1);
            expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["archive"]);
            expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
        }
    );

    it("gives the notice which was held back after a restart, once nothing more is to come", async () => {
        const first = setup();
        first.state.chunksArrived = false;
        first.state.deferredRemoteContent = true;
        first.processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(first.setSnapshot)).toEqual(["one"]));
        const snapshot = latestSnapshot(first.setSnapshot);

        const restarted = setup({ getSnapshot: async () => snapshot });
        restarted.state.chunksArrived = false;
        await restarted.processor.restoreFromSnapshotOnce();
        // The first synchronisation after the restart still expects content, and the next one does not.
        restarted.state.deferredRemoteContent = true;
        restarted.processor.retryWaitingChanges();
        await vi.waitFor(() => expect(restarted.getDBEntryFromMeta).toHaveBeenCalledTimes(1));
        await settle();
        restarted.state.deferredRemoteContent = false;
        restarted.processor.retryWaitingChanges();
        await vi.waitFor(() => expect(restarted.getDBEntryFromMeta).toHaveBeenCalledTimes(2));
        await settle();

        expect(logLevels(restarted.logs)).toEqual([LOG_LEVEL_VERBOSE, LOG_LEVEL_NOTICE]);
        expect(waitingInLatestSnapshot(restarted.setSnapshot)).toEqual(["one"]);
        expect(waitingWithoutNoticeInLatestSnapshot(restarted.setSnapshot)).toEqual([]);
    });

    it("loads a snapshot of an earlier version, whose waiting documents were all reported", async () => {
        const restarted = setup({ getSnapshot: async () => ({ queued: [], processing: [], waiting: [note("one")] }) });
        restarted.state.chunksArrived = false;
        await restarted.processor.restoreFromSnapshotOnce();

        restarted.processor.retryWaitingChanges();
        await vi.waitFor(() => expect(restarted.getDBEntryFromMeta).toHaveBeenCalledOnce());
        await settle();

        expect(logLevels(restarted.logs)).toEqual([LOG_LEVEL_VERBOSE]);
        expect(waitingInLatestSnapshot(restarted.setSnapshot)).toEqual(["one"]);
    });

    it("does not give the notice held back for one revision to another revision which was already reported", async () => {
        const { state, processor, setSnapshot, getDBEntryFromMeta, logs } = setup();
        state.chunksArrived = false;
        state.deferredRemoteContent = true;
        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual(["one"]));

        // A newer revision arrives, and is reported because its latest revision cannot be checked.
        state.lookupFailure = "error";
        processor.enqueueAll([{ ...note("one"), _rev: "2-newer" } as PouchDB.Core.ExistingDocument<EntryDoc>]);
        await vi.waitFor(() => expect(logLevels(logs, "Could not check whether")).toEqual([LOG_LEVEL_NOTICE]));
        await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]));

        // Its content then turns out to be missing, when nothing more is to come.
        state.lookupFailure = undefined;
        state.latest.one = ["2-newer", "1-test"];
        state.deferredRemoteContent = false;
        processor.retryWaitingChanges();
        await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledTimes(2));
        await settle();

        expect(logLevels(logs)).toEqual([LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE]);
    });

    describe("for a file whose content was removed from the remote after the file was deleted", () => {
        /** Every notice the processor gave. */
        const notices = (logs: ReturnType<typeof setup>["logs"]) =>
            logs.mock.calls.filter(([, level]) => level === LOG_LEVEL_NOTICE).map(([message]) => String(message));
        const storeDeletion = (state: ReturnType<typeof setup>["state"], id: string) => {
            state.latest[id] = ["2-deletion", "1-test"];
        };

        it.each([
            ["while the journals with documents are received", true],
            ["when nothing more is to come", false],
        ])(
            "drops the file without a notice when its deletion was stored before its content could not be gathered, %s",
            async (_case, deferredRemoteContent) => {
                const { state, processor, processSynchroniseResult, setSnapshot, getDBEntryFromMeta, logs } = setup({
                    remoteType: REMOTE_MINIO,
                });
                state.deferredRemoteContent = deferredRemoteContent;
                // The file is the latest revision when it is taken up, and no longer when its content turns out
                // to be missing.
                getDBEntryFromMeta.mockImplementationOnce(async () => {
                    storeDeletion(state, "one");
                    return false;
                });

                processor.enqueueAll([note("one")]);
                await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledOnce());
                await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));

                expect(notices(logs)).toEqual([]);
                expect(logLevels(logs)).toEqual([]);
                expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
                // Nothing waits, so nothing is tried again.
                processor.retryWaitingChanges();
                await settle();
                expect(getDBEntryFromMeta).toHaveBeenCalledOnce();
                expect(processSynchroniseResult).not.toHaveBeenCalled();
            }
        );

        it("holds the notice back when the deletion is stored after the content could not be gathered, and then drops both", async () => {
            const { state, processor, processSynchroniseResult, setSnapshot, getDBEntryFromMeta, logs } = setup({
                remoteType: REMOTE_MINIO,
            });
            state.chunksArrived = false;
            // The journals with documents are being received, so content counts as still to come.
            state.deferredRemoteContent = true;
            processor.enqueueAll([note("one")]);
            await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual(["one"]));
            expect(logLevels(logs)).toEqual([LOG_LEVEL_INFO]);

            // A later journal of the same receive holds the deletion. Then the receive ends, with nothing to come.
            storeDeletion(state, "one");
            state.deferredRemoteContent = false;
            processor.retryWaitingChanges();
            await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));

            expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
            expect(notices(logs)).toEqual([]);
            expect(getDBEntryFromMeta).toHaveBeenCalledOnce();
            expect(processSynchroniseResult).not.toHaveBeenCalled();
        });

        it("stops waiting for the file when its deletion is stored while it is tried again", async () => {
            const { state, processor, setSnapshot, getDBEntryFromMeta, logs } = setup({ remoteType: REMOTE_MINIO });
            state.chunksArrived = false;
            state.deferredRemoteContent = true;
            processor.enqueueAll([note("one")]);
            await vi.waitFor(() => expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual(["one"]));

            // Nothing more is to come when it is tried again, and its deletion is stored during that try.
            state.deferredRemoteContent = false;
            getDBEntryFromMeta.mockImplementationOnce(async () => {
                storeDeletion(state, "one");
                return false;
            });
            processor.retryWaitingChanges();
            await vi.waitFor(() => expect(getDBEntryFromMeta).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));

            expect(waitingWithoutNoticeInLatestSnapshot(setSnapshot)).toEqual([]);
            expect(notices(logs)).toEqual([]);
        });

        it("still gives the notice when the file is the latest revision and its content is missing", async () => {
            const { state, processor, setSnapshot, logs } = setup({ remoteType: REMOTE_MINIO });
            state.chunksArrived = false;

            processor.enqueueAll([note("one")]);
            await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

            expect(logLevels(logs)).toEqual([LOG_LEVEL_NOTICE]);
        });

        it("still keeps the file waiting when its latest revision cannot be checked after the content could not be gathered", async () => {
            const { state, processor, setSnapshot, getDBEntryFromMeta, logs } = setup({ remoteType: REMOTE_MINIO });
            getDBEntryFromMeta.mockImplementationOnce(async () => {
                state.lookupFailure = "error";
                return false;
            });

            processor.enqueueAll([note("one")]);
            await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual(["one"]));

            expect(logLevels(logs)).toEqual([LOG_LEVEL_NOTICE]);
        });

        it("does not let ten such files hold the places of what is queued behind them", async () => {
            const { state, processor, processSynchroniseResult, setSnapshot, getDBEntryFromMeta, logs } = setup({
                remoteType: REMOTE_MINIO,
            });
            // The journals with documents are being received, so content counts as still to come. A read which
            // waited for chunks would stay pending for as long as that receive runs.
            state.deferredRemoteContent = true;
            getDBEntryFromMeta.mockImplementation(async (entry: { _id: string; _rev: string }, ...rest) => {
                if (entry._id === "note") return { ...entry, data: "x" };
                if (rest[1] === true) await new Promise<void>(() => {});
                return false;
            });
            const removed = Array.from({ length: 10 }, (_, index) => binaryNote(`removed-${index}`, 1_000_000));

            processor.enqueueAll([...removed, note("note")]);

            await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
            expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "note" }));
            await vi.waitFor(() =>
                expect(waitingInLatestSnapshot(setSnapshot)?.sort()).toEqual(removed.map((doc) => doc._id).sort())
            );

            // Their deletions arrive with a later journal, and the receive ends.
            for (const doc of removed) storeDeletion(state, doc._id);
            state.deferredRemoteContent = false;
            processor.retryWaitingChanges();
            await vi.waitFor(() => expect(waitingInLatestSnapshot(setSnapshot)).toEqual([]));

            expect(notices(logs)).toEqual([]);
            expect(processSynchroniseResult).toHaveBeenCalledOnce();
        });
    });
});

describe("ReplicateResultProcessor snapshots before the previous queue is restored", () => {
    it("takes no snapshot until the snapshot of the previous run has been restored", async () => {
        const { processor, processSynchroniseResult, setSnapshot } = setup({ restore: false });

        processor.enqueueAll([note("one")]);
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        await settle();
        expect(setSnapshot).not.toHaveBeenCalled();

        await processor.restoreFromSnapshotOnce();
        processor.enqueueAll([note("two")]);
        await vi.waitFor(() => expect(setSnapshot).toHaveBeenCalled());
    });

    it("tries a restoration which failed again, and takes snapshots only after it succeeds", async () => {
        let reads = 0;
        const { processor, setSnapshot } = setup({
            restore: false,
            getSnapshot: async () => {
                if (++reads === 1) throw new Error("the key-value database is busy");
                return undefined;
            },
        });

        await expect(processor.restoreFromSnapshotOnce()).rejects.toThrow("the key-value database is busy");
        processor.enqueueAll([note("one")]);
        await settle();
        expect(setSnapshot).not.toHaveBeenCalled();

        await expect(processor.restoreFromSnapshotOnce()).resolves.toBeUndefined();
        processor.enqueueAll([note("two")]);
        await vi.waitFor(() => expect(setSnapshot).toHaveBeenCalled());
    });
});

const SNAPSHOT_KEY = "replicationResultProcessorSnapshot";
const REPROCESS_POSITION_KEY = "replicationResultProcessorReprocessPosition";

/** A keyed key-value store which records its writes, like the real one and unlike the set/get pair. */
function memoryStore() {
    const map = new Map<string, unknown>();
    const store = {
        get: vi.fn(async (key: string) => map.get(key)),
        set: vi.fn(async (key: string, value: unknown) => void map.set(key, structuredClone(value))),
        del: vi.fn(async (key: string) => void map.delete(key)),
    };
    return { store, map };
}
/** Reach the private queue of a processor, to fill or inspect it without going through the throttle. */
function queueOf(processor: ReplicateResultProcessor) {
    return processor as unknown as {
        _queuedChanges: {
            enqueue(doc: unknown): void;
            dequeue(): { _id: string } | undefined;
            size: number;
            values(): IterableIterator<{ _id: string }>;
        };
        _takeSnapshot(): Promise<void>;
    };
}

/** A store which throws after a given number of successful set/del operations, to model a crash at each point. */
function crashingStore(seed?: Map<string, unknown>) {
    const map = new Map<string, unknown>(seed ? [...seed].map(([k, v]) => [k, structuredClone(v)]) : []);
    let limit = Infinity;
    let done = 0;
    /** Runs before each store operation, to interleave a concurrent queue mutation as runProcessQueue would. */
    let beforeOp: (() => void) | undefined;
    const guard = () => {
        beforeOp?.();
        if (done >= limit) throw new Error("crash");
        done++;
    };
    const store = {
        get: vi.fn(async (key: string) => map.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
            guard();
            map.set(key, structuredClone(value));
        }),
        del: vi.fn(async (key: string) => {
            guard();
            map.delete(key);
        }),
    };
    return {
        store,
        map,
        get operations() {
            return done;
        },
        crashAfter(n: number) {
            limit = n;
            done = 0;
        },
        set beforeEachOp(fn: (() => void) | undefined) {
            beforeOp = fn;
        },
    };
}
const padId = (prefix: string, index: number) => `${prefix}-${index.toString().padStart(7, "0")}`;

describe("ReplicateResultProcessor enqueue without scanning the queue", () => {
    async function measureSkip(length: number): Promise<number> {
        const { store } = memoryStore();
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const queue = queueOf(processor);
        for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
        const before = queue._queuedChanges.size;
        // Enqueueing the first id again with its own revision is a no-op, found through the index, not a scan.
        processor.enqueueAll([note(padId("doc", 0))]);
        return before - queue._queuedChanges.size + 1;
    }

    it("skips the same id with the same revision, however long the queue is", async () => {
        expect(await measureSkip(SNAPSHOT_INLINE_LIMIT + 50)).toBe(1);
        expect(await measureSkip(SNAPSHOT_INLINE_LIMIT * 3)).toBe(1);
    });

    it("replaces a queued id in place with a new revision instead of adding a second entry", async () => {
        const { store } = memoryStore();
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const queue = queueOf(processor);
        for (let i = 0; i < SNAPSHOT_INLINE_LIMIT + 10; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
        const before = queue._queuedChanges.size;

        processor.enqueueAll([
            { ...note(padId("doc", 0)), _rev: "2-newer" } as PouchDB.Core.ExistingDocument<EntryDoc>,
        ]);

        expect(queue._queuedChanges.size).toBe(before);
        const ids = [...queue._queuedChanges.values()].map((doc) => doc._id);
        expect(ids.filter((id) => id === padId("doc", 0))).toHaveLength(1);
    });
});

describe("ReplicateResultProcessor hybrid snapshot", () => {
    /** Fill a suspended processor's queue to `length`, persist it, then measure persisting one more document. */
    async function measureOneMore(length: number) {
        const { store } = memoryStore();
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const queue = queueOf(processor);
        for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
        await queue._takeSnapshot();
        store.set.mock.calls.length = 0;
        store.del.mock.calls.length = 0;
        queue._queuedChanges.enqueue(note("doc-one-more"));
        await queue._takeSnapshot();
        const written = store.set.mock.calls.map(([, value]) => JSON.stringify(value).length);
        return { writes: store.set.mock.calls.length, bytes: written.reduce((a, b) => a + b, 0) };
    }

    it("writes no document data proportional to the queue length for one more queued document", async () => {
        const shorter = await measureOneMore(SNAPSHOT_INLINE_LIMIT + SNAPSHOT_PAGE_SIZE + 5);
        const longer = await measureOneMore(SNAPSHOT_INLINE_LIMIT + SNAPSHOT_PAGE_SIZE * 5 + 5);
        // The same number of store writes whatever the length: the one changed page, and the base record.
        expect(shorter.writes).toBe(longer.writes);
        // No document data grows with the length. The base names one key per overflow page, so a longer queue adds
        // only those extra short keys, not any re-serialised documents: the per-change bytes differ by far less than
        // even a single page of documents would occupy, where re-serialising the queue would differ by the lot.
        expect(longer.bytes - shorter.bytes).toBeLessThan(SNAPSHOT_PAGE_SIZE);
    });

    it("writes one record of the released shape while the queue is within the inline bound", async () => {
        const { store, map } = memoryStore();
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const queue = queueOf(processor);
        for (let i = 0; i < SNAPSHOT_INLINE_LIMIT; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
        await queue._takeSnapshot();
        const record = map.get(SNAPSHOT_KEY) as Record<string, unknown>;
        expect(Object.keys(record).sort()).toEqual(["processing", "queued", "waiting", "waitingWithoutNotice"]);
        expect((record.queued as unknown[]).length).toBe(SNAPSHOT_INLINE_LIMIT);
        expect([...map.keys()]).toEqual([SNAPSHOT_KEY]);
    });

    it("pages the queue above the bound, keeping the head in the base record and the rest under derived keys", async () => {
        const { store, map } = memoryStore();
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const queue = queueOf(processor);
        const length = SNAPSHOT_PAGE_SIZE * 3;
        for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
        await queue._takeSnapshot();
        const record = map.get(SNAPSHOT_KEY) as { queued: unknown[]; overflow: string[] };
        expect(record.queued.length).toBe(SNAPSHOT_PAGE_SIZE);
        // The base names, in queue order, one generation-tagged key per overflow page, and each key holds a page.
        expect(record.overflow).toEqual([`${SNAPSHOT_KEY}:q:1:1`, `${SNAPSHOT_KEY}:q:1:2`]);
        for (const key of record.overflow) expect(map.has(key)).toBe(true);
    });
});

describe("ReplicateResultProcessor snapshot that survives a crash at any point", () => {
    /** A processor whose snapshots may be taken directly, with no auto-restore and no throttled writes to race. */
    function directProcessor(kv: unknown) {
        const { processor } = setup({ restore: false, applicationReady: false, kv: kv as never });
        (processor as unknown as { _snapshotRestored: boolean })._snapshotRestored = true;
        return processor;
    }
    /** Restore a fresh processor from a store map, and return the ids it holds (queued and waiting). */
    async function restoredIds(map: Map<string, unknown>): Promise<Set<string>> {
        const store = {
            get: async (key: string) => map.get(key),
            set: async () => undefined,
            del: async () => undefined,
        };
        const { processor } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        const ids = new Set<string>([...queueOf(processor)._queuedChanges.values()].map((doc) => doc._id));
        const waiting = (map.get(SNAPSHOT_KEY) as { waiting?: { _id: string }[] } | undefined)?.waiting ?? [];
        for (const doc of waiting) ids.add(doc._id);
        return ids;
    }

    /**
     * Take a committed snapshot of the filled state, mutate it, then take a second snapshot which crashes after
     * each store operation; assert every id that was committed and is still live is restored (duplicates allowed,
     * losses not). Each run uses its own processor which itself took the committed snapshot, so its stored-overflow
     * bookkeeping matches the disk, and the queue is driven directly so no throttled snapshot races the crash.
     */
    async function assertNoLossAtEveryCrash(
        fill: (queue: ReturnType<typeof queueOf>) => void,
        mutate: (queue: ReturnType<typeof queueOf>) => void,
        /** Optional mutation run before each store operation of the crashing snapshot, modelling a concurrent drain. */
        interleave?: (queue: ReturnType<typeof queueOf>) => void
    ) {
        // A clean committed state, and the ids required to survive (committed and still live after the mutation).
        const probeRun = crashingStore();
        const probe = directProcessor(probeRun.store);
        fill(queueOf(probe));
        await queueOf(probe)._takeSnapshot();
        const committedIds = new Set([...queueOf(probe)._queuedChanges.values()].map((doc) => doc._id));
        const opsBeforeMutation = probeRun.operations;
        mutate(queueOf(probe));
        const liveIds = new Set([...queueOf(probe)._queuedChanges.values()].map((doc) => doc._id));
        const required = [...committedIds].filter((id) => liveIds.has(id));
        await queueOf(probe)._takeSnapshot();
        const totalOps = probeRun.operations - opsBeforeMutation;
        expect(totalOps).toBeGreaterThan(0);

        for (let crashAfter = 0; crashAfter <= totalOps; crashAfter++) {
            const run = crashingStore();
            const processor = directProcessor(run.store);
            fill(queueOf(processor));
            await queueOf(processor)._takeSnapshot();
            mutate(queueOf(processor));
            run.crashAfter(crashAfter);
            // The interleave runs before each store op of this snapshot, so a dequeue or enqueue lands between its
            // awaited writes exactly as runProcessQueue would on an unsuspended, draining queue.
            if (interleave) run.beforeEachOp = () => interleave(queueOf(processor));
            await queueOf(processor)
                ._takeSnapshot()
                .catch(() => undefined);
            run.beforeEachOp = undefined;
            const restored = await restoredIds(run.map);
            for (const id of required) {
                expect(restored.has(id), `id ${id} lost when crashing after ${crashAfter} of ${totalOps}`).toBe(true);
            }
        }
    }

    it("loses nothing when a paged snapshot crashes while a re-enqueue moves an id to a new page", async () => {
        // Exactly full pages, so moving an id out of an overflow page appends it to a brand-new page. The old page
        // loses the id and the new page gains it; each is rewritten under its own fresh-generation key before the
        // base flips to name them, so no key the committed base still relies on is overwritten mid-rewrite.
        const length = SNAPSHOT_PAGE_SIZE * 3;
        await assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                queue._queuedChanges.enqueue({
                    ...note(padId("doc", SNAPSHOT_PAGE_SIZE + 5)),
                    _rev: "2-moved",
                } as never);
                queue._queuedChanges.dequeue();
            }
        );
    });

    // A document on the second overflow page: the head holds docs 0..N-1, the first overflow page the next N, the
    // second overflow page the next N after that (N = SNAPSHOT_PAGE_SIZE).
    const onPageTwo = (index: number) => padId("doc", SNAPSHOT_PAGE_SIZE * 2 + index);

    /**
     * Fill, then re-enqueue an id off a full in-range overflow page so it spills to a brand-new page, while that same
     * page is topped up to full by a freshly received id. The page is at once a source (it loses the moved id, a hole)
     * and a destination (it gains the received id). A whole-page write that reused the page's existing key would, on a
     * crash after that write but before the base flips, leave the committed base naming a page from which the moved id
     * is gone while its new page is not yet named: the fresh-generation key is what keeps the old page readable until
     * the base no longer needs it. The received id is post-commit, so only the moved id must survive.
     */
    function moveOutToNewPageWhileGaining(interleave?: (queue: ReturnType<typeof queueOf>) => void) {
        const length = SNAPSHOT_PAGE_SIZE * 2 + (SNAPSHOT_PAGE_SIZE - 1);
        return assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                // Top the partially full second overflow page up to full with a received id (it gains), then move an
                // id already on it to a brand-new page (it loses). The page is both source and destination.
                queue._queuedChanges.enqueue(note("received-fill"));
                queue._queuedChanges.enqueue({ ...note(onPageTwo(0)), _rev: "2-moved" } as never);
            },
            interleave
        );
    }

    it("loses nothing when an id moves off a full in-range page that is also gaining a received id", async () => {
        await moveOutToNewPageWhileGaining();
    });

    it("loses nothing when that move races a concurrent dequeue and enqueue at any crash point", async () => {
        let once = 0;
        await moveOutToNewPageWhileGaining((queue) => {
            queue._queuedChanges.dequeue();
            if (once++ === 0) queue._queuedChanges.enqueue(note("interleaved-out"));
        });
    });

    /**
     * Fill, then re-enqueue an id off the head page into a partially full in-range overflow page, while that same page
     * also gains a freshly received id. The moved id leaves the base record (a head hole) for an overflow page, so the
     * overflow page that gains it must be written and named before the base drops it from the head.
     */
    function moveFromHeadIntoInRangePage(interleave?: (queue: ReturnType<typeof queueOf>) => void) {
        const length = SNAPSHOT_PAGE_SIZE * 2 + SNAPSHOT_PAGE_SIZE / 2;
        return assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                // A received id lands on the partially full in-range page (it gains), and an id from the head page
                // moves onto it too (the head loses it): the in-range page gains two, one of them off the head.
                queue._queuedChanges.enqueue(note("received-into"));
                queue._queuedChanges.enqueue({ ...note(padId("doc", 3)), _rev: "2-from-head" } as never);
            },
            interleave
        );
    }

    it("loses nothing when an id moves from the head into an in-range page that is also gaining a received id", async () => {
        await moveFromHeadIntoInRangePage();
    });

    it("loses nothing when that head move races a concurrent dequeue and enqueue at any crash point", async () => {
        let once = 0;
        await moveFromHeadIntoInRangePage((queue) => {
            queue._queuedChanges.dequeue();
            if (once++ === 0) queue._queuedChanges.enqueue(note("interleaved-head"));
        });
    });

    it("loses nothing when dequeues and an enqueue interleave with a paged snapshot, at any crash point", async () => {
        const length = SNAPSHOT_PAGE_SIZE * 3;
        let interleaved = 0;
        await assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                // A change that makes the second snapshot a real paged write, with several store operations.
                queue._queuedChanges.enqueue({
                    ...note(padId("doc", SNAPSHOT_PAGE_SIZE + 5)),
                    _rev: "2-moved",
                } as never);
            },
            (queue) => {
                // A concurrent drain, as runProcessQueue performs between its own awaits on an unsuspended queue.
                queue._queuedChanges.dequeue();
                if (interleaved++ === 0) queue._queuedChanges.enqueue(note("interleaved-new"));
            }
        );
    });

    it("loses nothing when a snapshot after a restore crashes while it re-pages the queue", async () => {
        const length = SNAPSHOT_PAGE_SIZE * 2 + 40;
        // A committed paged state, with a document in processing. A restore prepends processing to the queue, so
        // re-paging shifts every page by one: new content under the same page numbers but a fresh generation. The
        // fresh-generation key keeps a crash mid-rewrite from overwriting a key the stored base still names.
        const old = crashingStore();
        const op = directProcessor(old.store);
        for (let i = 0; i < length; i++) queueOf(op)._queuedChanges.enqueue(note(padId("doc", i)));
        await queueOf(op)._takeSnapshot();
        const baseRecord = old.map.get(SNAPSHOT_KEY) as { processing: unknown[] };
        old.map.set(SNAPSHOT_KEY, { ...baseRecord, processing: [note("proc-0")] });
        const committedIds = new Set(["proc-0", ...[...queueOf(op)._queuedChanges.values()].map((doc) => doc._id)]);

        // A fresh processor restores from that state and re-pages it; no throttled snapshot races, so the first
        // snapshot is the full rewrite under fresh page numbers. Crash after each of its operations.
        const buildRestored = async (kv: {
            get(k: string): Promise<unknown>;
            set(k: string, v: unknown): Promise<unknown>;
            del?(k: string): Promise<void>;
        }) => {
            const { processor } = setup({ restore: false, applicationReady: false, kv });
            (processor as unknown as { triggerTakeSnapshot(): void }).triggerTakeSnapshot = () => undefined;
            await processor.restoreFromSnapshotOnce();
            return processor;
        };
        const counter = crashingStore(old.map);
        const probe = await buildRestored(counter.store);
        const opsBefore = counter.operations;
        await queueOf(probe)._takeSnapshot();
        const totalOps = counter.operations - opsBefore;
        expect(totalOps).toBeGreaterThan(0);

        for (let crashAfter = 0; crashAfter <= totalOps; crashAfter++) {
            const run = crashingStore(old.map);
            const processor = await buildRestored(run.store);
            run.crashAfter(crashAfter);
            await queueOf(processor)
                ._takeSnapshot()
                .catch(() => undefined);
            const restored = await restoredIds(run.map);
            for (const id of committedIds) {
                expect(restored.has(id), `id ${id} lost when crashing after ${crashAfter} of ${totalOps}`).toBe(true);
            }
        }
    });

    it("loses nothing when an inline snapshot crashes after growth within the bound", async () => {
        await assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < 10; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                for (let i = 10; i < 20; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            }
        );
    });

    it("loses nothing when a paged queue shrinks back under the inline bound and crashes", async () => {
        const length = SNAPSHOT_PAGE_SIZE * 2 + 10;
        await assertNoLossAtEveryCrash(
            (queue) => {
                for (let i = 0; i < length; i++) queue._queuedChanges.enqueue(note(padId("doc", i)));
            },
            (queue) => {
                // Drain most of the queue so the next snapshot is inline and must clear the overflow keys.
                for (let i = 0; i < length - 5; i++) queue._queuedChanges.dequeue();
            }
        );
    });
});

describe("ReplicateResultProcessor restore of a large stored queue", () => {
    it("restores every waiting document, in operations proportional to the length and not its square", async () => {
        const { store } = memoryStore();
        const length = SNAPSHOT_PAGE_SIZE * 3 + 7;
        const first = setup({ applicationReady: false, kv: store });
        await first.processor.restoreFromSnapshotOnce();
        const ids: string[] = [];
        const queue = queueOf(first.processor);
        for (let i = 0; i < length; i++) {
            const id = padId("doc", i);
            ids.push(id);
            queue._queuedChanges.enqueue(note(id));
        }
        await queue._takeSnapshot();

        const second = setup({ applicationReady: false, kv: store });
        const enqueueAll = vi.spyOn(second.processor, "enqueueAll");
        store.get.mock.calls.length = 0;
        await second.processor.restoreFromSnapshotOnce();

        const restored = [...queueOf(second.processor)._queuedChanges.values()].map((doc) => doc._id);
        expect(restored.length).toBe(length);
        expect([...restored].sort()).toEqual([...ids].sort());
        const enqueued = enqueueAll.mock.calls.reduce((sum, [docs]) => sum + (docs as unknown[]).length, 0);
        expect(enqueued).toBe(length);
        // Linear, not quadratic: one slice of up to RESTORE_SLICE_SIZE at a time.
        expect(enqueueAll.mock.calls.length).toBe(Math.ceil(length / RESTORE_SLICE_SIZE));
        // Reads do not grow per document: the base record and one read per overflow page.
        expect(store.get.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(length / SNAPSHOT_PAGE_SIZE));
    });

    it("restores a record stored without an overflow field exactly as before", async () => {
        const { store, map } = memoryStore();
        map.set(SNAPSHOT_KEY, { queued: [note("one")], processing: [], waiting: [note("two")] });
        const { processor, processSynchroniseResult } = setup({ kv: store });

        await processor.restoreFromSnapshotOnce();

        await vi.waitFor(() =>
            expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "one" }))
        );
        await vi.waitFor(() => expect(waitingInLatestSnapshot(store.set)).toEqual(["two"]));
    });
});

describe("ReplicateResultProcessor reprocessing a changed filter", () => {
    const storedDoc = (id: string) =>
        ({
            _id: id,
            _rev: "1-a",
            type: "plain",
            path: `${id}.md`,
        }) as unknown as PouchDB.Core.ExistingDocument<EntryDoc>;
    // Mirrors REPROCESS_BATCH_SIZE in the processor: the reprocessing flushes and stores its position per batch.
    const REPROCESS_BATCH = 100;

    it("resumes after a restart without reprocessing or missing any document, with a bounded queue", async () => {
        const { store } = memoryStore();
        const total = REPROCESS_BATCH * 6;
        const allIds = Array.from({ length: total }, (_, i) => padId("file", i));
        const enqueued: string[] = [];
        let maxQueue = 0;
        /** Record the ids a run enqueues, and let the real queue fill and drain so the bound can be observed. */
        const recordEnqueues = (processor: ReplicateResultProcessor) => {
            const real = processor.enqueueAll.bind(processor);
            vi.spyOn(processor, "enqueueAll").mockImplementation((docs) => {
                for (const doc of docs) enqueued.push(doc._id);
                real(docs);
            });
        };
        const setFindAllNormalDocs = (processor: ReplicateResultProcessor, gen: () => AsyncGenerator<unknown>) => {
            (
                processor.core as unknown as { localDatabase: { findAllNormalDocs: () => AsyncGenerator<unknown> } }
            ).localDatabase.findAllNormalDocs = gen;
        };

        // The first run is cut off after reading three batches of the database.
        const cutAfter = REPROCESS_BATCH * 3;
        const first = setup({
            kv: store,
            processSynchroniseResult: async () => {
                maxQueue = Math.max(maxQueue, queueOf(first.processor)._queuedChanges.size);
                return true;
            },
        });
        await first.processor.restoreFromSnapshotOnce();
        setFindAllNormalDocs(first.processor, async function* () {
            for (let i = 0; i < total; i++) {
                if (i === cutAfter) throw new Error("the application was closed");
                yield storedDoc(allIds[i]);
            }
        });
        recordEnqueues(first.processor);
        await expect(first.processor.reprocessStoredDocuments()).rejects.toThrow("the application was closed");
        expect(await store.get(REPROCESS_POSITION_KEY)).toBeDefined();

        // The next run reads the whole database and continues after the stored position.
        const second = setup({ kv: store, processSynchroniseResult: async () => true });
        await second.processor.restoreFromSnapshotOnce();
        setFindAllNormalDocs(second.processor, async function* () {
            for (let i = 0; i < total; i++) yield storedDoc(allIds[i]);
        });
        recordEnqueues(second.processor);
        await expect(second.processor.reprocessStoredDocuments()).resolves.toBeGreaterThan(0);

        // Every stored document ends enqueued exactly once, and the position is cleared.
        expect(new Set(enqueued).size).toBe(total);
        expect([...new Set(enqueued)].sort()).toEqual([...allIds].sort());
        expect(enqueued.length).toBe(total);
        expect(await store.get(REPROCESS_POSITION_KEY)).toBeUndefined();
        expect(maxQueue).toBeLessThanOrEqual(REPROCESS_QUEUE_LIMIT);
    });

    it("fails loudly when the database yields documents out of ascending id order", async () => {
        const { store } = memoryStore();
        const { processor } = setup({ kv: store });
        (
            processor.core as unknown as { localDatabase: { findAllNormalDocs: () => AsyncGenerator<unknown> } }
        ).localDatabase.findAllNormalDocs = async function* () {
            yield storedDoc("file-2");
            yield storedDoc("file-1");
        };

        await expect(processor.reprocessStoredDocuments()).rejects.toThrow("ascending id order");
    });

    it("stops without spinning when the processor is suspended mid-pass, and continues on resume", async () => {
        const { store } = memoryStore();
        // More than the queue bound, so the suspended queue fills and the pass must stop rather than spin.
        const total = REPROCESS_QUEUE_LIMIT + REPROCESS_BATCH * 5;
        const allIds = Array.from({ length: total }, (_, i) => padId("file", i));
        // The processor is suspended, so nothing drains; the queue fills to the bound and the pass must stop.
        const { processor, lifecycle } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        let cursorClosed = false;
        (
            processor.core as unknown as { localDatabase: { findAllNormalDocs: () => AsyncGenerator<unknown> } }
        ).localDatabase.findAllNormalDocs = async function* () {
            try {
                for (let i = 0; i < total; i++) yield storedDoc(allIds[i]);
            } finally {
                cursorClosed = true;
            }
        };

        // The pass returns rather than spinning forever, and the database cursor is released.
        await expect(
            Promise.race([
                processor.reprocessStoredDocuments(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("spun forever")), 2000)),
            ])
        ).resolves.toBeGreaterThanOrEqual(0);
        expect(cursorClosed).toBe(true);
        const position = await store.get(REPROCESS_POSITION_KEY);
        expect(position).toBeDefined();

        // On resume the pass continues from the stored position and finishes.
        const findAgain = vi.fn(async function* () {
            for (let i = 0; i < total; i++) yield storedDoc(allIds[i]);
        });
        (
            processor.core as unknown as { localDatabase: { findAllNormalDocs: unknown } }
        ).localDatabase.findAllNormalDocs = findAgain;
        // Resume for real: the queue can drain now, so the continued pass finishes.
        lifecycle.ready = true;
        processor.resume();
        await vi.waitFor(async () => expect(await store.get(REPROCESS_POSITION_KEY)).toBeUndefined());
        expect(findAgain).toHaveBeenCalled();
    });

    it("continues an interrupted pass from the ready hook, without an explicit resume", async () => {
        const { store } = memoryStore();
        const total = REPROCESS_QUEUE_LIMIT + REPROCESS_BATCH * 5;
        const allIds = Array.from({ length: total }, (_, i) => padId("file", i));
        // Suspended through the application not being ready, not through an explicit suspend.
        const { processor, lifecycle } = setup({ applicationReady: false, kv: store });
        await processor.restoreFromSnapshotOnce();
        (
            processor.core as unknown as { localDatabase: { findAllNormalDocs: () => AsyncGenerator<unknown> } }
        ).localDatabase.findAllNormalDocs = async function* () {
            for (let i = 0; i < total; i++) yield storedDoc(allIds[i]);
        };
        await expect(processor.reprocessStoredDocuments()).resolves.toBeGreaterThanOrEqual(0);
        expect(await store.get(REPROCESS_POSITION_KEY)).toBeDefined();

        (
            processor.core as unknown as { localDatabase: { findAllNormalDocs: () => AsyncGenerator<unknown> } }
        ).localDatabase.findAllNormalDocs = async function* () {
            for (let i = 0; i < total; i++) yield storedDoc(allIds[i]);
        };
        // The application becomes ready and the ready hook runs; no resume() is called.
        lifecycle.ready = true;
        processor.resumeAfterApplicationReady();
        await vi.waitFor(async () => expect(await store.get(REPROCESS_POSITION_KEY)).toBeUndefined());
    });
});

describe("ReplicateResultProcessor queue holding one entry per id", () => {
    /** The documents reflected to the vault, in order; a reflected deletion carries _deleted. */
    function reflectionsOf(processSynchroniseResult: ReturnType<typeof vi.fn>): { _id: string; _deleted?: boolean }[] {
        return processSynchroniseResult.mock.calls.map(([doc]) => doc as { _id: string; _deleted?: boolean });
    }
    const deletedNote = (id: string, rev: string) =>
        ({ ...note(id), _rev: rev, _deleted: true }) as unknown as PouchDB.Core.ExistingDocument<EntryDoc>;
    const revisedNote = (id: string, rev: string) =>
        ({ ...note(id), _rev: rev }) as unknown as PouchDB.Core.ExistingDocument<EntryDoc>;

    it("ends with the file deleted when a create and then a delete of one id are queued together", async () => {
        const { state, processor, processSynchroniseResult } = setup();
        state.latest.one = ["2-del", "1-make"];

        processor.enqueueAll([revisedNote("one", "1-make"), deletedNote("one", "2-del")]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        const reflected = reflectionsOf(processSynchroniseResult).filter((doc) => doc._id === "one");
        expect(reflected).toHaveLength(1);
        expect(reflected[0]._deleted).toBe(true);
    });

    it("ends with the file present when a delete and then a create of one id are queued together", async () => {
        const { state, processor, processSynchroniseResult } = setup();
        state.latest.one = ["2-make", "1-del"];

        processor.enqueueAll([deletedNote("one", "1-del"), revisedNote("one", "2-make")]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        const reflected = reflectionsOf(processSynchroniseResult).filter((doc) => doc._id === "one");
        expect(reflected).toHaveLength(1);
        expect(reflected[0]._deleted ?? false).toBe(false);
    });

    it("skips an id enqueued again with the same revision", async () => {
        const { processor, processSynchroniseResult, logs } = setup();

        processor.enqueueAll([note("one"), note("one")]);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        await settle();
        expect(processSynchroniseResult).toHaveBeenCalledOnce();
        expect(logs.mock.calls.filter(([message]) => String(message).includes("Already queued"))).toHaveLength(1);
    });
});
