import { afterEach, describe, expect, it, vi } from "vitest";
import { handlers } from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";
import { createServiceContext } from "@vrtmrz/livesync-commonlib/context";
import { performFullScan } from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/offlineScanner";
import { prepareDatabaseForUse } from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/prepareDatabaseForUse";
import { EVEN } from "@vrtmrz/livesync-commonlib/compat/common/models/shared.const.symbols";
import { REMOTE_MINIO } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type {
    DatabasePreparationOptions,
    VaultScanOutcome,
} from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import { ModuleLiveSyncMain } from "./ModuleLiveSyncMain";
import { ModuleMigration } from "@/modules/essential/ModuleMigration";
import { COMPROMISED_CHUNK_SCAN_RECEIPT_KEY } from "@vrtmrz/livesync-commonlib/compat/pouchdb/negotiation";

vi.mock("@/modules/features/SetupManager.ts", () => ({ SetupManager: class SetupManager {} }));
vi.mock("@/deps.ts", () => ({}));
vi.mock("@/common/utils.ts", () => ({ isValidPath: () => true }));

const ERR_INITIALISATION_FAILED = "Initializing database has been failed on some module!";

/** What the preparation and the start-up scan take as their host. */
type StartupHost = Parameters<typeof prepareDatabaseForUse>[0] & Parameters<typeof performFullScan>[0];
type StartupErrorManager = Parameters<typeof prepareDatabaseForUse>[2];
type StartupCore = ConstructorParameters<typeof ModuleLiveSyncMain>[0];

type StartupOptions = {
    /** Whether the start-up scan can write the file which is only in the database. */
    chunksArrived: boolean;
    /** A file only in storage which cannot be stored into the database. */
    unstorableFile?: boolean;
    /** Whether the storage access can queue storage events again. */
    queuesStorageEvents?: boolean;
    databaseReady?: boolean;
    configured?: boolean;
    databaseInitialised?: boolean;
    commits?: boolean;
    /** Recording the scanner's `initialized` marker fails, after the aggregate result. */
    failInitialisedMark?: boolean;
    /** A fatal error thrown while preparing or scanning the local database. */
    startupError?: unknown;
};

/**
 * A plug-in start-up over Commonlib's own database preparation and start-up scan, with one file in the database
 * which storage does not have yet.
 */
function createStartupHarness(options: StartupOptions) {
    const phases: string[] = [];
    const settings = {
        isConfigured: options.configured ?? true,
        handleFilenameCaseSensitive: true,
        automaticallyDeleteMetadataOfDeletedFiles: 0,
        maxMTimeForReflectEvents: 0,
        suspendFileWatching: false,
        suspendParseReplicationResult: false,
    };
    const document = {
        _id: "archive.zip",
        _rev: "1-received",
        path: "archive.zip",
        ctime: 1,
        mtime: 2,
        size: 700,
        children: ["h:missing"],
        type: "newnote",
        datatype: "newnote",
        eden: {},
    };
    const log = vi.fn();
    // The preparation and the scan use only these two methods of the error manager.
    const errorManager: Pick<StartupErrorManager, "showError" | "clearError"> = {
        showError: vi.fn(),
        clearError: vi.fn(),
    };
    const parseSynchroniseResult = vi.fn(async () => true);
    const appendStorageEvents = vi.fn(async () => undefined);
    const phase =
        (name: string, result = true) =>
        async () => {
            phases.push(name);
            return result;
        };
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
            onReady: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            onWireUpEvents: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            onLoad: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            onResumed: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            onSuspending: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            onBeforeUnload: handlers<{ event(): Promise<boolean> }>().bailFirstFailure("event"),
            isSuspended: vi.fn(() => false),
            setSuspended: vi.fn((_value: boolean) => undefined),
            onLayoutReady: vi.fn(async () => true),
            hasUnloaded: vi.fn(() => false),
            isReady: vi.fn(() => true),
            resetIsReady: vi.fn(),
            markIsReady: vi.fn(() => {
                phases.push("markIsReady");
            }),
            onFirstInitialise: vi.fn(phase("onFirstInitialise")),
            onScanningStartupIssues: vi.fn(async () => true),
        },
        setting: { currentSettings: () => settings },
        vault: {
            isTargetFile: vi.fn(async () => true),
            isValidPath: vi.fn(() => true),
            isFileSizeTooLarge: vi.fn(() => false),
            // Like the maintained handler dispatch, an error becomes a failed scan.
            scanVault: vi.fn(
                async (
                    showingNotice?: boolean,
                    ignoreSuspending?: boolean,
                    outcome?: VaultScanOutcome
                ): Promise<boolean> => {
                    try {
                        return await performFullScan(host, log, errorManager as StartupErrorManager, {
                            showingNotice,
                            ignoreSuspending,
                            outcome,
                        });
                    } catch {
                        return false;
                    }
                }
            ),
        },
        path: {
            getPath: (entry: { path: string }) => entry.path,
            path2id: async (path: string) => path,
            compareFileFreshness: () => EVEN,
        },
        database: {
            isDatabaseReady: vi.fn(() => options.databaseReady ?? true),
            openDatabase: vi.fn(async () => true),
            localDatabase: {
                findAllNormalDocs: async function* () {
                    yield document;
                },
                findAllDocs: async function* () {
                    // No expired deletion history.
                },
            },
        },
        databaseEvents: {
            initialiseDatabase: vi.fn(
                async (
                    showingNotice: boolean,
                    reopenDatabase: boolean,
                    ignoreSuspending: boolean,
                    preparation?: DatabasePreparationOptions
                ): Promise<boolean> => {
                    if (options.startupError !== undefined) throw options.startupError;
                    return await prepareDatabaseForUse(
                        host,
                        log,
                        errorManager as StartupErrorManager,
                        showingNotice,
                        reopenDatabase,
                        ignoreSuspending,
                        preparation
                    );
                }
            ),
            onDatabaseInitialised: vi.fn(phase("onDatabaseInitialised", options.databaseInitialised ?? true)),
        },
        fileProcessing: { commitPendingFileEvents: vi.fn(phase("commitPendingFileEvents", options.commits ?? true)) },
        keyValueDB: {
            kvDB: {
                get: vi.fn(async () => undefined),
                set: vi.fn(async (key: string) => {
                    if (key === "initialized" && options.failInitialisedMark) {
                        throw new Error("the marker could not be written");
                    }
                }),
            },
        },
        replication: {
            parseSynchroniseResult,
            replicate: vi.fn(phase("replicate")),
            replicateByEvent: vi.fn(phase("replicateByEvent")),
        },
        control: { applySettings: vi.fn(phase("applySettings")) },
    };
    const dbToStorage = vi.fn(async () => options.chunksArrived);
    const storeFileToDB = vi.fn(async () => {
        throw new Error("storage could not be read");
    });
    const fakeHost = {
        services,
        serviceModules: {
            storageAccess: {
                getFiles: vi.fn(async () =>
                    options.unstorableFile ? [{ path: "created.md", stat: { size: 10, mtime: 50 } }] : []
                ),
                ...(options.queuesStorageEvents ? { appendStorageEvents } : {}),
            },
            // The scan stores a file under the lock of its storage events.
            fileHandler: { dbToStorage, storeFileToDBUnderFileEventLock: storeFileToDB },
        },
    };
    // The preparation, the scan and the start-up reach only the members these fakes provide.
    const host = fakeHost as unknown as StartupHost;
    const core = { _services: services, services, settings } as unknown as StartupCore;
    const module = new ModuleLiveSyncMain(core);
    const startupLog = vi.spyOn(module, "_log");
    return {
        module,
        services,
        phases,
        errorManager,
        dbToStorage,
        parseSynchroniseResult,
        appendStorageEvents,
        startupLog,
    };
}

/** The lines of the start-up log which state how the files the scan could not process are tried again. */
function retryLines(startupLog: { mock: { calls: unknown[][] } }): string[] {
    return startupLog.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("could not process"));
}

const COMPLETE_STARTUP = [
    "onDatabaseInitialised",
    "commitPendingFileEvents",
    "markIsReady",
    "onFirstInitialise",
    "applySettings",
];

function createMobileLifecycleHarness() {
    const h = createStartupHarness({ chunksArrived: true });
    const state = { ready: true, suspended: false, unloaded: false };
    Object.assign(h.services.API, { isMobile: () => true });
    Object.assign(h.services.setting.currentSettings(), { remoteType: REMOTE_MINIO, syncOnStart: true });
    Object.assign(h.services.vault, { prepareForEarlyReplication: vi.fn(async () => true) });
    h.services.appLifecycle.isReady.mockImplementation(() => state.ready);
    h.services.appLifecycle.isSuspended.mockImplementation(() => state.suspended);
    h.services.appLifecycle.hasUnloaded.mockImplementation(() => state.unloaded);
    h.services.appLifecycle.resetIsReady.mockImplementation(() => {
        state.ready = false;
    });
    h.services.appLifecycle.markIsReady.mockImplementation(() => {
        h.phases.push("markIsReady");
        state.ready = true;
    });
    h.services.appLifecycle.setSuspended.mockImplementation((value) => {
        state.suspended = value;
    });
    h.module.onBindFunction(h.module.core as never, h.services as never);
    return { ...h, state };
}

describe("deferred mobile scan lifecycle", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("schedules replication with the real migration gate while a 174k historical rescan is blocked", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        const historicalScan = vi.fn(async () => await new Promise<never>(() => undefined));
        const pouch = {
            id: async () => "synthetic-large-db",
            info: async () => ({ update_seq: 174_019, doc_count: 174_019 }),
            find: historicalScan,
        };
        Object.assign(h.module.core, {
            localDatabase: { ...h.services.database.localDatabase, localDatabase: pouch, isReady: true },
            kvDB: {
                get: vi.fn(async (key: string) =>
                    key === COMPROMISED_CHUNK_SCAN_RECEIPT_KEY
                        ? {
                              version: 1,
                              policy: "leaf-h-namespace-v1",
                              databaseId: "synthetic-large-db",
                              verifiedSequence: 174_019,
                          }
                        : undefined
                ),
                set: vi.fn(),
            },
        });
        Object.assign(h.module.core.settings, { encrypt: true });
        Object.assign(h.services, {
            replicator: { getActiveReplicator: () => ({ countCompromisedChunks: async () => 0 }) },
        });
        Object.assign(h.services.API, { isOnline: true });
        const migration = new ModuleMigration(h.module.core as never);
        vi.spyOn(migration, "migrateUsingDoctor").mockResolvedValue(true);
        vi.spyOn(migration, "migrateDisableBulkSend").mockResolvedValue(undefined);
        h.services.appLifecycle.onFirstInitialise.mockImplementation(
            async () => await migration._everyOnFirstInitialize()
        );
        let finish: ((value: boolean) => void) | undefined;
        h.services.vault.scanVault.mockImplementation(
            async () =>
                await new Promise<boolean>((resolve) => {
                    finish = resolve;
                })
        );
        expect(await h.module._onLiveSyncReady()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(historicalScan).not.toHaveBeenCalled();
        expect(h.services.replication.replicate).toHaveBeenCalledOnce();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        h.state.unloaded = true;
        finish?.(true);
        await vi.runAllTimersAsync();
    });

    it("runs the postscan replication exactly once and never scans again on resume after success", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.services.vault.scanVault.mockResolvedValue(true);
        expect(await h.module._onLiveSyncReady()).toBe(true);
        await vi.runAllTimersAsync();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        expect(h.services.replication.replicateByEvent).toHaveBeenCalledOnce();
        await h.services.appLifecycle.onResumed();
        await vi.runAllTimersAsync();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        expect(h.services.replication.replicateByEvent).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("retains completion across hide after the scan succeeds and sends once on resume", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.services.vault.scanVault.mockImplementation(async () => {
            h.state.suspended = true;
            return true;
        });
        await h.module._onLiveSyncReady();
        await vi.runAllTimersAsync();
        expect(h.services.replication.replicateByEvent).not.toHaveBeenCalled();
        h.state.suspended = false;
        await h.services.appLifecycle.onResumed();
        await vi.runAllTimersAsync();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        expect(h.services.replication.replicateByEvent).toHaveBeenCalledOnce();
    });

    it("hands queued per-path failures over without repeating the full metadata enumeration", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.services.vault.scanVault.mockImplementation(async (_show, _ignore, outcome) => {
            Object.assign(outcome ?? {}, { failedPairs: 2, queuedForReflection: 1, queuedAsStorageEvents: 1 });
            return false;
        });
        await h.module._onLiveSyncReady();
        await vi.runAllTimersAsync();
        await vi.advanceTimersByTimeAsync(3_600_000);
        await h.services.appLifecycle.onResumed();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        expect(h.services.replication.replicateByEvent).toHaveBeenCalledOnce();
        expect(h.services.appLifecycle.setSuspended).not.toHaveBeenCalled();
    });

    it("keeps a global scan failure blocking replication and readiness", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.services.vault.scanVault.mockResolvedValue(false);
        await h.module._onLiveSyncReady();
        await vi.runAllTimersAsync();
        expect(h.state.ready).toBe(false);
        expect(h.state.suspended).toBe(true);
        expect(h.services.replication.replicateByEvent).not.toHaveBeenCalled();
        await h.services.appLifecycle.onResumed();
        await vi.runAllTimersAsync();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
    });

    it.each(["reject", "false"])(
        "retains a bounded postscan retry after a transient %s without suspending",
        async (failure) => {
            vi.useFakeTimers();
            const h = createMobileLifecycleHarness();
            h.services.vault.scanVault.mockResolvedValue(true);
            if (failure === "reject")
                h.services.replication.replicateByEvent.mockRejectedValueOnce(new Error("synthetic network timeout"));
            else h.services.replication.replicateByEvent.mockResolvedValueOnce(false);
            await h.module._onLiveSyncReady();
            await vi.advanceTimersByTimeAsync(0);
            expect(h.services.replication.replicateByEvent).toHaveBeenCalledOnce();
            expect(h.services.appLifecycle.setSuspended).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(h.services.replication.replicateByEvent).toHaveBeenCalledTimes(2);
            expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
            await h.services.appLifecycle.onResumed();
            await vi.runAllTimersAsync();
            expect(h.services.replication.replicateByEvent).toHaveBeenCalledTimes(2);
        }
    );

    it("waits for resume while suspended and bounds readiness retries while visible", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.state.suspended = true;
        h.state.ready = false;
        await h.module._onLiveSyncReady();
        h.state.ready = false;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.services.vault.scanVault).not.toHaveBeenCalled();
        h.state.suspended = false;
        await h.services.appLifecycle.onResumed();
        await vi.runAllTimersAsync();
        expect(vi.getTimerCount()).toBe(0);
        expect(h.services.vault.scanVault).not.toHaveBeenCalled();
        h.state.ready = true;
        h.services.vault.scanVault.mockResolvedValue(true);
        await h.services.appLifecycle.onResumed();
        await vi.runAllTimersAsync();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
    });

    it("composes hide, interrupted scan, resume and unload without polling or late postscan work", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        let finish: ((value: boolean) => void) | undefined;
        let currentOutcome: VaultScanOutcome | undefined;
        h.services.vault.scanVault.mockImplementation(async (_show, _ignore, outcome) => {
            currentOutcome = outcome;
            return await new Promise<boolean>((resolve) => {
                finish = resolve;
            });
        });
        await h.module._onLiveSyncReady();
        await vi.advanceTimersByTimeAsync(0);
        h.state.suspended = true;
        await h.services.appLifecycle.onSuspending();
        Object.assign(currentOutcome ?? {}, { interrupted: true });
        finish?.(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        h.state.suspended = false;
        await h.services.appLifecycle.onResumed();
        expect(h.services.vault.scanVault).toHaveBeenCalledTimes(2);
        h.state.unloaded = true;
        await h.services.appLifecycle.onBeforeUnload();
        finish?.(true);
        await vi.runAllTimersAsync();
        await h.services.appLifecycle.onResumed();
        expect(h.services.vault.scanVault).toHaveBeenCalledTimes(2);
        expect(h.services.replication.replicateByEvent).not.toHaveBeenCalled();
        expect(h.services.replication.replicate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not schedule deferred work when unload interrupts settings application", async () => {
        vi.useFakeTimers();
        const h = createMobileLifecycleHarness();
        h.services.control.applySettings.mockImplementationOnce(async () => {
            h.state.unloaded = true;
            await h.services.appLifecycle.onBeforeUnload();
            return true;
        });
        expect(await h.module._onLiveSyncReady()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.services.vault.scanVault).not.toHaveBeenCalled();
        expect(h.services.replication.replicate).not.toHaveBeenCalled();
    });
});

describe("ModuleLiveSyncMain start-up", () => {
    it("reaches the normal security hooks and initial sync before a mobile full metadata enumeration completes", async () => {
        vi.useFakeTimers();
        const h = createStartupHarness({ chunksArrived: true });
        Object.assign(h.services.API, { isMobile: () => true });
        Object.assign(h.services.setting.currentSettings(), { remoteType: REMOTE_MINIO, syncOnStart: true });
        Object.assign(h.services.appLifecycle, { isSuspended: () => false });
        Object.assign(h.services.vault, { prepareForEarlyReplication: vi.fn(async () => true) });
        let finish: ((value: boolean) => void) | undefined;
        h.services.vault.scanVault.mockImplementationOnce(async () => {
            h.phases.push("scanStart");
            return await new Promise<boolean>((resolve) => {
                finish = resolve;
            });
        });
        expect(await h.module._onLiveSyncReady()).toBe(true);
        expect(h.phases).toEqual(COMPLETE_STARTUP);
        expect(h.services.databaseEvents.initialiseDatabase).toHaveBeenCalledWith(
            false,
            false,
            false,
            expect.objectContaining({ deferFullScan: true })
        );
        expect(h.services.replication.replicate).not.toHaveBeenCalled();
        expect(h.services.vault.scanVault).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        expect(h.phases).toEqual([...COMPLETE_STARTUP, "replicate", "scanStart"]);
        expect(h.services.replication.replicate).toHaveBeenCalledOnce();
        expect(h.services.vault.scanVault).toHaveBeenCalledOnce();
        vi.mocked(h.services.appLifecycle.hasUnloaded).mockReturnValue(true);
        finish?.(true);
        await Promise.resolve();
        vi.useRealTimers();
    });

    it("does not open or scan the database when the host was unloaded while the layout became ready", async () => {
        const { module, phases, services } = createStartupHarness({ chunksArrived: true });
        vi.mocked(services.appLifecycle.hasUnloaded).mockReturnValue(true);

        await expect(module._onLiveSyncReady()).resolves.toBe(false);

        expect(services.databaseEvents.initialiseDatabase).not.toHaveBeenCalled();
        expect(phases).not.toContain("onFirstInitialise");
    });

    it("completes start-up when only a file whose chunks have not arrived could not be written", async () => {
        const { module, phases, dbToStorage, parseSynchroniseResult, startupLog } = createStartupHarness({
            chunksArrived: false,
        });

        await expect(module._onLiveSyncReady()).resolves.toBe(true);

        expect(dbToStorage).toHaveBeenCalledOnce();
        expect(phases).toEqual(COMPLETE_STARTUP);
        // The file is handed to the queue of received changes, which writes it once its chunks arrive.
        expect(parseSynchroniseResult).toHaveBeenCalledWith([expect.objectContaining({ _id: "archive.zip" })]);
        expect(retryLines(startupLog)).toEqual([
            expect.stringMatching(
                /could not process 1 file\(s\), and start-up continues\. They are tried again: 1 to be written from the database .* again before each synchronisation, also after a restart\./
            ),
        ]);
    });

    it("states which files are queued again as storage events and which wait for the next full scan", async () => {
        const queued = createStartupHarness({ chunksArrived: true, unstorableFile: true, queuesStorageEvents: true });
        await expect(queued.module._onLiveSyncReady()).resolves.toBe(true);
        expect(queued.appendStorageEvents).toHaveBeenCalledOnce();
        expect(retryLines(queued.startupLog)).toEqual([
            expect.stringContaining("They are tried again: 1 to be stored into the database from the storage events"),
        ]);

        const unqueued = createStartupHarness({ chunksArrived: true, unstorableFile: true });
        await expect(unqueued.module._onLiveSyncReady()).resolves.toBe(true);
        expect(retryLines(unqueued.startupLog)).toEqual([
            expect.stringContaining("They are tried again: 1 at the next full scan."),
        ]);
        expect(unqueued.phases).toEqual(COMPLETE_STARTUP);
    });

    it("completes start-up without a retry line when the start-up scan could write every file", async () => {
        const { module, phases, parseSynchroniseResult, startupLog } = createStartupHarness({ chunksArrived: true });

        await expect(module._onLiveSyncReady()).resolves.toBe(true);

        expect(phases).toEqual(COMPLETE_STARTUP);
        expect(parseSynchroniseResult).not.toHaveBeenCalled();
        expect(retryLines(startupLog)).toEqual([]);
    });

    it.each<[string, Partial<StartupOptions>]>([
        ["the local database is not ready", { databaseReady: false }],
        ["the start-up scan could not run", { configured: false }],
        ["an error follows the aggregate result of the scan", { failInitialisedMark: true }],
    ])("stops start-up when %s", async (_case, options) => {
        const { module, services, phases } = createStartupHarness({ chunksArrived: false, ...options });

        await expect(module._onLiveSyncReady()).resolves.toBe(false);

        expect(phases).toEqual([]);
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("stops before replication and gives recovery guidance when IndexedDB cannot be read", async () => {
        const databaseError = new Error("indexed_db_went_bad: unknown");
        const { module, services, phases, startupLog } = createStartupHarness({
            chunksArrived: false,
            startupError: databaseError,
        });

        await expect(module._onLiveSyncReady()).resolves.toBe(false);

        expect(phases).toEqual([]);
        expect(services.appLifecycle.onFirstInitialise).not.toHaveBeenCalled();
        expect(startupLog).toHaveBeenCalledWith(
            expect.stringMatching(/indexed_db_went_bad.*stopped before replication.*Back up this Vault/s),
            expect.anything()
        );
        expect(startupLog).toHaveBeenCalledWith(databaseError, expect.anything());
    });

    it("preserves an unexpected database start-up error for the existing error boundary", async () => {
        const databaseError = new Error("unexpected scan failure");
        const { module } = createStartupHarness({ chunksArrived: false, startupError: databaseError });

        await expect(module._onLiveSyncReady()).rejects.toBe(databaseError);
    });

    it("stops start-up with the usual error when the completion hooks fail after failed files", async () => {
        const { module, services, phases, errorManager } = createStartupHarness({
            chunksArrived: false,
            databaseInitialised: false,
        });

        await expect(module._onLiveSyncReady()).resolves.toBe(false);

        expect(phases).toEqual(["onDatabaseInitialised"]);
        expect(errorManager.showError).toHaveBeenCalledWith(ERR_INITIALISATION_FAILED, expect.anything());
        expect(services.appLifecycle.onFirstInitialise).not.toHaveBeenCalled();
    });

    it("stops start-up when the pending file events cannot be released after failed files", async () => {
        const { module, services, phases } = createStartupHarness({ chunksArrived: false, commits: false });

        await expect(module._onLiveSyncReady()).resolves.toBe(false);

        expect(phases).toEqual(["onDatabaseInitialised", "commitPendingFileEvents"]);
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(services.appLifecycle.onFirstInitialise).not.toHaveBeenCalled();
    });
});
