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
import type { EntryDoc } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { ModuleReplicator } from "./ModuleReplicator";

class TestAppLifecycleService extends InjectableAppLifecycleService {}

function createResultApplicationHarness(options: { snapshot: PouchDB.Core.ExistingDocument<EntryDoc>[] }) {
    const context = createServiceContext();
    const settings = { isConfigured: true, maxMTimeForReflectEvents: 0, suspendParseReplicationResult: false };
    const appLifecycle = new TestAppLifecycleService(context, {
        settingService: { currentSettings: () => settings },
    } as never);
    const processSynchroniseResult = vi.fn(async () => undefined);
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
        kvDB: {
            get: vi.fn(async () => ({ queued: options.snapshot, processing: [] })),
            set: vi.fn(async () => undefined),
        },
        localDatabase: {
            getRaw: vi.fn(async (id: string) => ({ _id: id, _rev: "1-test" })),
            getDBEntryFromMeta: vi.fn(async (entry: object) => ({ ...entry, data: "x" })),
        },
    } as any;
    const module = new ModuleReplicator(core);
    module.onBindFunction(core, services as never);
    return { appLifecycle, module, processSynchroniseResult, settings };
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
