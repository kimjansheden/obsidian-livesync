import { promiseWithResolvers } from "octagonal-wheels/promises";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it, vi } from "vitest";
import {
    LARGE_FILE_BYTES,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type EntryDoc,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { ReplicateResultProcessor } from "./ReplicateResultProcessor";

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
    };
    const settings = {
        maxMTimeForReflectEvents: options.maxMTimeForReflectEvents ?? 0,
        suspendParseReplicationResult: false,
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
            replicator: { runBoundedLocalApplicationActivity },
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
        kvDB: { set: setSnapshot, get: getSnapshot },
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
