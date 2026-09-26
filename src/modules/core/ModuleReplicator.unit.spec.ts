import { describe, expect, it, vi } from "vitest";
import { createServiceContext } from "@vrtmrz/livesync-commonlib/context";
import { EVENT_SETTING_SAVED, eventHub } from "@/common/events";
import type { ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";

const chunkMocks = vi.hoisted(() => ({
    purgeUnreferencedChunks: vi.fn(async (_db: unknown, countOnly: boolean) => (countOnly ? 2 : 0)),
    balanceChunkPurgedDBs: vi.fn(async () => undefined),
}));

vi.mock("@vrtmrz/livesync-commonlib/compat/pouchdb/chunks", () => chunkMocks);
vi.mock("@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator", () => ({
    LiveSyncCouchDBReplicator: class {},
}));

import { LiveSyncCouchDBReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator";
import { InjectableAppLifecycleService } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableAppLifecycleService";
import { prepareDatabaseForUse } from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/prepareDatabaseForUse";
import {
    FullScanModes,
    synchroniseAllFilesBetweenDBandStorage,
} from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/offlineScanner";
import type { VaultScanOutcome } from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import type { EntryDoc } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { ModuleReplicator } from "./ModuleReplicator";

class TestAppLifecycleService extends InjectableAppLifecycleService {}

function createResultApplicationHarness(options: {
    snapshot: PouchDB.Core.ExistingDocument<EntryDoc>[];
    /** Whether a snapshot the processor takes replaces the stored one, as the key-value database does. */
    persistSnapshots?: boolean;
    /** Reading the stored snapshot fails. */
    restoreFails?: boolean;
}) {
    const stored = new Map<string, unknown>([
        ["replicationResultProcessorSnapshot", { queued: options.snapshot, processing: [] }],
    ]);
    const context = createServiceContext();
    const settings = { isConfigured: true, maxMTimeForReflectEvents: 0, suspendParseReplicationResult: false };
    const appLifecycle = new TestAppLifecycleService(context, {
        settingService: { currentSettings: () => settings },
    } as never);
    const processSynchroniseResult = vi.fn(async (_entry: { _id: string; path: string }) => true);
    const handler = () => ({ addHandler: vi.fn() });
    const services = {
        context,
        API: {
            addLog: vi.fn(),
            addCommand: vi.fn(),
            registerWindow: vi.fn(),
            addRibbonIcon: vi.fn(),
            registerProtocolHandler: vi.fn(),
        },
        appLifecycle,
        databaseEvents: { onDatabaseInitialised: handler() },
        path: { getPath: (entry: { path: string }) => entry.path },
        replication: {
            databaseQueueCount: reactiveSource(0),
            storageApplyingCount: reactiveSource(0),
            replicationResultCount: reactiveSource(0),
            onBeforeReplicate: handler(),
            onReplicationFailed: handler(),
            parseSynchroniseResult: handler(),
            processOptionalSynchroniseResult: vi.fn(async () => false),
            processSynchroniseResult,
            processVirtualDocument: vi.fn(async () => false),
        },
        replicator: { onReplicatorInitialised: handler() },
        setting: { currentSettings: () => settings },
        vault: {
            isFileSizeTooLarge: vi.fn(() => false),
            isTargetFile: vi.fn(async () => true),
            isValidPath: vi.fn(() => true),
        },
    };
    const core = {
        _services: services,
        services,
        settings,
        serviceModules: { storageAccess: { stat: vi.fn(async () => null) } },
        kvDB: {
            get: vi.fn(async (key: string) => {
                if (options.restoreFails) throw new Error("the key-value database is busy");
                return stored.get(key);
            }),
            set: vi.fn(async (key: string, value: unknown) => {
                if (options.persistSnapshots) stored.set(key, value);
            }),
        },
        localDatabase: {
            getRaw: vi.fn(async (id: string) => ({ _id: id, _rev: "1-test" })),
            getDBEntryFromMeta: vi.fn(async (entry: object): Promise<object | false> => ({ ...entry, data: "x" })),
            inspectDBEntryBinaryContent: vi.fn(async (): Promise<string> => "streamable"),
        },
    } as any;
    const module = new ModuleReplicator(core);
    module.onBindFunction(core, services as never);
    return { appLifecycle, core, module, processSynchroniseResult, settings };
}

function restoredNote(id: string): PouchDB.Core.ExistingDocument<EntryDoc> {
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The ids of the queue in the latest snapshot the processor stored, in their order, or `undefined` before any. */
function storedQueue(core: { kvDB: { set: { mock: { calls: unknown[][] } } } }) {
    const calls = core.kvDB.set.mock.calls;
    if (calls.length === 0) return undefined;
    const snapshot = calls[calls.length - 1][1] as { queued: { _id: string }[]; processing: { _id: string }[] };
    return [...snapshot.processing, ...snapshot.queued].map((doc) => doc._id);
}

describe("ModuleReplicator result application readiness", () => {
    it("applies documents restored before readiness once the application becomes ready", async () => {
        const { appLifecycle, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
        });

        await module.processor.restoreFromSnapshotOnce();
        await settle();
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        appLifecycle.markIsReady();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(appLifecycle.isReady()).toBe(true);
    });

    it("applies documents restored during database preparation once Commonlib marks readiness", async () => {
        const { appLifecycle, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
        });
        let appliedBeforeReady: number | undefined;
        const host = {
            services: {
                appLifecycle,
                database: { isDatabaseReady: () => true },
                databaseEvents: {
                    onDatabaseInitialised: async () => {
                        await module.processor.restoreFromSnapshotOnce();
                        return true;
                    },
                },
                fileProcessing: {
                    commitPendingFileEvents: async () => {
                        await settle();
                        appliedBeforeReady = processSynchroniseResult.mock.calls.length;
                        return true;
                    },
                },
                vault: { scanVault: async () => true },
            },
        };

        await expect(
            prepareDatabaseForUse(
                host as never,
                vi.fn(),
                { clearError: vi.fn(), showError: vi.fn() } as never,
                false,
                false
            )
        ).resolves.toBe(true);

        expect(appliedBeforeReady).toBe(0);
        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });

    it("keeps an explicit reflection suspension when the application becomes ready", async () => {
        const { appLifecycle, module, processSynchroniseResult, settings } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
        });
        settings.suspendParseReplicationResult = true;

        await module.processor.restoreFromSnapshotOnce();
        appLifecycle.markIsReady();
        await settle();

        expect(processSynchroniseResult).not.toHaveBeenCalled();
    });

    it("keeps a suspended processor suspended when the application becomes ready", async () => {
        const { appLifecycle, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
        });

        await module.processor.restoreFromSnapshotOnce();
        module.processor.suspend();
        appLifecycle.markIsReady();
        await settle();

        expect(processSynchroniseResult).not.toHaveBeenCalled();
    });

    it("restores the queue of the previous run before it queues documents handed over by the start-up scan", async () => {
        const { appLifecycle, core, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
            persistSnapshots: true,
        });

        // The start-up scan hands over a document it could not write before the database is initialised.
        await expect(module._parseReplicationResult([restoredNote("scanned")])).resolves.toBe(true);

        // The stored queue holds both at once, before anything else restores it, so a restart meanwhile loses neither.
        await vi.waitFor(() => expect(storedQueue(core)).toEqual(["restored", "scanned"]));
        appLifecycle.markIsReady();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledTimes(2));
        const applied = processSynchroniseResult.mock.calls.map((call) => (call as unknown[])[0] as { _id: string });
        expect(applied.map((entry) => entry._id).sort()).toEqual(["restored", "scanned"]);
    });

    it("still queues documents when the previous queue cannot be restored, and keeps the stored queue", async () => {
        const { appLifecycle, core, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("restored")],
            restoreFails: true,
        });

        await expect(module._parseReplicationResult([restoredNote("scanned")])).resolves.toBe(true);
        appLifecycle.markIsReady();

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
        expect(processSynchroniseResult).toHaveBeenCalledWith(expect.objectContaining({ _id: "scanned" }));
        await settle();
        expect(core.kvDB.set).not.toHaveBeenCalled();
    });

    it("tries a document whose content could not be gathered again before each replication", async () => {
        const { appLifecycle, core, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [restoredNote("waiting")],
        });
        core.localDatabase.getDBEntryFromMeta.mockResolvedValueOnce(false);
        await module.processor.restoreFromSnapshotOnce();
        appLifecycle.markIsReady();
        await vi.waitFor(() => expect(core.localDatabase.getDBEntryFromMeta).toHaveBeenCalledOnce());
        await settle();
        expect(processSynchroniseResult).not.toHaveBeenCalled();

        await expect(module._everyBeforeReplicate(false)).resolves.toBe(true);

        await vi.waitFor(() => expect(processSynchroniseResult).toHaveBeenCalledOnce());
    });
});

describe("ModuleReplicator with a file the start-up scan could not write", () => {
    it("writes the file once its chunks arrive, after the scan handed it over", async () => {
        const { appLifecycle, core, module, processSynchroniseResult } = createResultApplicationHarness({
            snapshot: [],
        });
        let chunksArrived = false;
        const written: string[] = [];
        // The same file handler writes for the scan and for the queue of received changes, once the chunks are there.
        const dbToStorage = vi.fn(async (entry: string | { path: string }) => {
            if (!chunksArrived) return false;
            written.push(typeof entry === "string" ? entry : entry.path);
            return true;
        });
        processSynchroniseResult.mockImplementation(async (entry) => await dbToStorage(entry));
        core.localDatabase.inspectDBEntryBinaryContent.mockImplementation(async () =>
            chunksArrived ? "streamable" : "missing"
        );
        const archive = {
            _id: "archive.zip",
            _rev: "1-received",
            path: "archive.zip",
            ctime: 1,
            mtime: 10,
            size: 700_000_000,
            children: ["h:part"],
            type: "newnote",
            datatype: "newnote",
            eden: {},
        };
        const scanHost = {
            services: {
                context: createServiceContext(),
                setting: { currentSettings: () => ({ handleFilenameCaseSensitive: true }) },
                vault: {
                    isTargetFile: async () => true,
                    isValidPath: () => true,
                    isFileSizeTooLarge: () => false,
                },
                path: { getPath: (entry: { path: string }) => entry.path, path2id: async (path: string) => path },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: async function* () {
                            yield archive;
                        },
                    },
                },
                keyValueDB: {},
                replication: {
                    parseSynchroniseResult: (docs: PouchDB.Core.ExistingDocument<EntryDoc>[]) =>
                        module._parseReplicationResult(docs),
                },
            },
            serviceModules: {
                storageAccess: { getFiles: async () => [] },
                fileHandler: { dbToStorage, storeFileToDB: vi.fn(), deleteFileFromDB: vi.fn() },
            },
        };
        const outcome: VaultScanOutcome = {};

        await expect(
            synchroniseAllFilesBetweenDBandStorage(scanHost as never, vi.fn(), {} as never, {
                mode: FullScanModes.DB_APPLY,
                outcome,
            })
        ).resolves.toBe(false);
        expect(outcome).toEqual({ failedPairs: 1, queuedForReflection: 1, queuedAsStorageEvents: 0 });

        appLifecycle.markIsReady();
        await vi.waitFor(() => expect(core.localDatabase.inspectDBEntryBinaryContent).toHaveBeenCalledOnce());
        await settle();
        expect(written).toEqual([]);

        chunksArrived = true;
        await expect(module._everyBeforeReplicate(false)).resolves.toBe(true);

        await vi.waitFor(() => expect(written).toEqual(["archive.zip"]));
        expect(core.localDatabase.getDBEntryFromMeta).not.toHaveBeenCalled();
    });
});

describe("ModuleReplicator", () => {
    it("refreshes the remote Security Seed before replication", async () => {
        const ensurePBKDF2Salt = vi.fn(async () => true);
        let beforeReplicate: ((showMessage: boolean) => Promise<boolean>) | undefined;
        const addHandler = vi.fn((handler: (showMessage: boolean) => Promise<boolean>, priority?: number) => {
            if (priority === 20) {
                beforeReplicate = handler;
            }
        });
        const services = {
            API: { isOnline: true },
            replicator: {
                onReplicatorInitialised: { addHandler: vi.fn() },
                getActiveReplicator: () => ({ ensurePBKDF2Salt }),
            },
            setting: { currentSettings: () => ({}) },
            databaseEvents: { onDatabaseInitialised: { addHandler: vi.fn() } },
            appLifecycle: { markIsReady: vi.fn(), onSettingLoaded: { addHandler: vi.fn() } },
            replication: {
                parseSynchroniseResult: { addHandler: vi.fn() },
                onBeforeReplicate: { addHandler },
                onReplicationFailed: { addHandler: vi.fn() },
            },
        };
        const module = {
            _unresolvedErrorManager: {
                showError: vi.fn(),
                clearError: vi.fn(),
            },
            _onReplicatorInitialised: vi.fn(),
            _everyOnDatabaseInitialized: vi.fn(),
            _everyOnloadAfterLoadSettings: vi.fn(),
            _parseReplicationResult: vi.fn(),
            _everyBeforeReplicate: vi.fn(),
            onReplicationFailed: vi.fn(),
        };

        ModuleReplicator.prototype.onBindFunction.call(module, {} as never, services as never);
        expect(beforeReplicate).toBeDefined();

        await beforeReplicate!(false);

        expect(ensurePBKDF2Salt).toHaveBeenCalledWith({}, false, false);
    });

    it("reprocesses stored documents when the normal-file target filters change", async () => {
        eventHub.offAll();
        const settings = {
            handleFilenameCaseSensitive: false,
            ignoreFiles: ".gitignore",
            maxMTimeForReflectEvents: 0,
            syncOnlyRegEx: "^E2E/allowed/.*",
            syncIgnoreRegEx: "",
            syncInternalFiles: false,
            syncMaxSizeInMB: 0,
            suspendParseReplicationResult: false,
            useIgnoreFiles: false,
        } as ObsidianLiveSyncSettings;
        const services = {
            context: createServiceContext(),
            API: {
                addLog: vi.fn(),
                addCommand: vi.fn(),
                registerWindow: vi.fn(),
                addRibbonIcon: vi.fn(),
                registerProtocolHandler: vi.fn(),
            },
            appLifecycle: {
                getUnresolvedMessages: { addHandler: vi.fn() },
                isReady: vi.fn(() => true),
                isSuspended: vi.fn(() => false),
            },
        };
        const core = {
            _services: services,
            services,
            settings,
        } as any;
        const module = new ModuleReplicator(core);
        const reprocessStoredDocuments = vi.fn(async () => 1);
        Object.assign(module.processor, { reprocessStoredDocuments });

        try {
            await (module as any)._everyOnloadAfterLoadSettings();
            eventHub.emitEvent(EVENT_SETTING_SAVED, { ...settings });
            await Promise.resolve();
            expect(reprocessStoredDocuments).not.toHaveBeenCalled();

            Object.assign(settings, { syncOnlyRegEx: "" });
            eventHub.emitEvent(EVENT_SETTING_SAVED, { ...settings });
            await vi.waitFor(() => expect(reprocessStoredDocuments).toHaveBeenCalledOnce());

            settings.syncMaxSizeInMB = 10;
            eventHub.emitEvent(EVENT_SETTING_SAVED, { ...settings });
            await vi.waitFor(() => expect(reprocessStoredDocuments).toHaveBeenCalledTimes(2));
        } finally {
            eventHub.offAll();
        }
    });
});

describe("compatibility: cleaned-remote reconciliation for IndexedDB clients", () => {
    it("keeps its finite replication and balancing work inside the shared activity boundary", async () => {
        const activityFinished = vi.fn();
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => {
            try {
                return await task();
            } finally {
                activityFinished();
            }
        });
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const openReplication = vi.fn(async () => true);
        const remoteDatabase = {
            close: vi.fn(async () => undefined),
        };
        const activeReplicator = Object.assign(new LiveSyncCouchDBReplicator({} as any), {
            connectRemoteCouchDBWithSetting: vi.fn(async () => ({ db: remoteDatabase })),
            markRemoteResolved: vi.fn(async () => undefined),
        });
        const services = {
            context: createServiceContext(),
            API: {
                addLog: vi.fn(),
                addCommand: vi.fn(),
                registerWindow: vi.fn(),
                addRibbonIcon: vi.fn(),
                registerProtocolHandler: vi.fn(),
                isMobile: vi.fn(() => false),
            },
            setting: { saveSettingData: vi.fn(async () => undefined) },
            appLifecycle: {
                getUnresolvedMessages: { addHandler: vi.fn() },
            },
            replicator: {
                getActiveReplicator: vi.fn(() => activeReplicator),
                runBoundedRemoteActivity,
                runFiniteReplicationActivity,
            },
        };
        const localDatabase = {
            localDatabase: {},
            clearCaches: vi.fn(),
        };
        const core = {
            _services: services,
            services,
            settings: {},
            localDatabase,
            confirm: { confirmWithMessage: vi.fn(async () => "Cleanup") },
            replicator: { openReplication },
        } as any;
        const module = new ModuleReplicator(core);

        await module.cleaned(true);

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "database-cleanup",
        });
        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(openReplication).toHaveBeenCalledOnce();
        expect(openReplication.mock.invocationCallOrder[0]).toBeLessThan(activityFinished.mock.invocationCallOrder[0]);
        expect(chunkMocks.balanceChunkPurgedDBs).toHaveBeenCalledOnce();
        expect(remoteDatabase.close).toHaveBeenCalledOnce();
        expect(remoteDatabase.close.mock.invocationCallOrder[0]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
    });
});
