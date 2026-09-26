import { describe, expect, it, vi } from "vitest";
import { createServiceContext } from "@vrtmrz/livesync-commonlib/context";
import { performFullScan } from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/offlineScanner";
import { prepareDatabaseForUse } from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/prepareDatabaseForUse";
import { EVEN } from "@vrtmrz/livesync-commonlib/compat/common/models/shared.const.symbols";
import type {
    DatabasePreparationOptions,
    VaultScanOutcome,
} from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import { ModuleLiveSyncMain } from "./ModuleLiveSyncMain";

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
            onLayoutReady: vi.fn(async () => true),
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
                ): Promise<boolean> =>
                    await prepareDatabaseForUse(
                        host,
                        log,
                        errorManager as StartupErrorManager,
                        showingNotice,
                        reopenDatabase,
                        ignoreSuspending,
                        preparation
                    )
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
        replication: { parseSynchroniseResult },
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
            fileHandler: { dbToStorage, storeFileToDB },
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

describe("ModuleLiveSyncMain start-up", () => {
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
