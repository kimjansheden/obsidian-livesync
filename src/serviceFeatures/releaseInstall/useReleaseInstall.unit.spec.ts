import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createQueueDowngradePreparation, releasePluginHostOf, useReleaseInstall } from "./useReleaseInstall";
import { ReplicateResultProcessor } from "../../modules/core/ReplicateResultProcessor";
import { QUEUE_SNAPSHOT_KEY, type QueueSnapshotStore } from "../../modules/core/ReplicationQueuePersistence";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RUNNING_RELEASE_NUMBER } from "./runningRelease";
import { TRUSTED_RELEASE_KEYS_FILE } from "./trustedReleaseKeys";
import {
    bytesOf,
    encodeBase64,
    generateTestKey,
    installSyntheticBuild,
    loadSyntheticBuild,
    MemoryAdapter,
    packageBytesOf,
    pluginFile,
    sha256HexOf,
    signedAfter,
    TEST_PLUGIN_DIRECTORY,
    TEST_PLUGIN_ID,
    testFiles,
    type SyntheticInstance,
    type TestKey,
} from "./_releaseTestKit";

const NEWER_RELEASE = RUNNING_RELEASE_NUMBER + 1;
type Handler = () => Promise<boolean>;

let KEY: TestKey;
let OTHER_KEY: TestKey;
beforeAll(async () => {
    KEY = await generateTestKey();
    OTHER_KEY = await generateTestKey();
});

afterEach(() => {
    vi.useRealTimers();
});

/** A synthetic host: a vault, the plug-in's folder, the app's plug-in manager and the services the feature reads. */
function createHost(
    options: {
        keysFile?: string | Uint8Array<ArrayBuffer>;
        isMobile?: boolean;
        withoutDeviceLocalStorage?: boolean;
        getQueueProcessor?: () => ReplicateResultProcessor;
    } = {}
) {
    const adapter = new MemoryAdapter();
    installSyntheticBuild(adapter, RUNNING_RELEASE_NUMBER);
    if (options.keysFile !== undefined) {
        const bytes = typeof options.keysFile === "string" ? bytesOf(options.keysFile) : options.keysFile;
        adapter.files.set(pluginFile(TRUSTED_RELEASE_KEYS_FILE), bytes);
    }
    const vaultFiles = new Map<string, Uint8Array<ArrayBuffer>>();
    const vaultListeners = new Map<string, (...args: { path: string }[] | [{ path: string }, string]) => void>();
    const localStorage = new Map<string, unknown>();
    const plugin = {
        ...(loadSyntheticBuild(adapter.files.get(pluginFile("main.js"))) as SyntheticInstance),
        manifest: { id: TEST_PLUGIN_ID, dir: TEST_PLUGIN_DIRECTORY, name: "Synthetic", version: "0.0.0" },
        registerEvent: vi.fn(),
        register: vi.fn(),
        app: undefined as unknown,
    };
    const plugins: Record<string, unknown> = { [TEST_PLUGIN_ID]: plugin };
    // The persisted enabled set, which the swap must never clear: the transient unload/load leave it untouched.
    const enabledPlugins = new Set<string>([TEST_PLUGIN_ID]);
    const manager = {
        plugins,
        enabledPlugins,
        unloadPlugin: vi.fn(async (id: string) => {
            delete plugins[id];
        }),
        loadPlugin: vi.fn(async (id: string) => {
            plugins[id] = loadSyntheticBuild(adapter.files.get(pluginFile("main.js")));
        }),
        // The persisting pair, present on the real host too; the swap must not use it. It clears the enabled set.
        disablePlugin: vi.fn(async (id: string) => {
            enabledPlugins.delete(id);
            delete plugins[id];
        }),
        enablePlugin: vi.fn(async (id: string) => {
            enabledPlugins.add(id);
            plugins[id] = loadSyntheticBuild(adapter.files.get(pluginFile("main.js")));
        }),
        loadManifests: vi.fn(async () => undefined),
    };
    const readPackage = vi.fn(async (file: { path: string }) => vaultFiles.get(file.path)!.slice().buffer);
    const getFiles = vi.fn(() =>
        [...vaultFiles].map(([path, bytes]) => ({
            path,
            extension: path.split(".").pop(),
            stat: { size: bytes.length },
        }))
    );
    const app = {
        vault: {
            adapter,
            configDir: ".config",
            getFiles,
            readBinary: readPackage,
            on: vi.fn((name: string, callback: (...args: never[]) => void) => {
                vaultListeners.set(name, callback as never);
                return { name };
            }),
        },
        plugins: manager,
    };
    plugin.app = app;
    const handlers = { settingLoaded: [] as Handler[], layoutReady: [] as Handler[] };
    const logs: string[] = [];
    const lifecycle = { unloaded: false, ready: true };
    const reactive = (value: number) => ({ value });
    const services = {
        API: {
            addLog: (message: unknown) => void logs.push(String(message)),
            isMobile: () => options.isMobile ?? false,
        },
        appLifecycle: {
            onSettingLoaded: { addHandler: (handler: Handler) => void handlers.settingLoaded.push(handler) },
            onLayoutReady: { addHandler: (handler: Handler) => void handlers.layoutReady.push(handler) },
            isReady: () => lifecycle.ready,
        },
        control: { hasUnloaded: () => lifecycle.unloaded },
        fileProcessing: {
            totalQueued: reactive(0),
            batched: reactive(0),
            processing: reactive(0),
            totalStorageFileEventCount: 0,
        },
        replication: {
            replicationResultCount: reactive(0),
            databaseQueueCount: reactive(0),
            storageApplyingCount: reactive(0),
            replicationCycleCount: reactive(0),
        },
        replicator: {
            boundedRemoteActivityCount: reactive(0),
            boundedLocalApplicationActivityCount: reactive(0),
            replicationStatics: { value: { syncStatus: "COMPLETED" } },
        },
    };
    const notices: { message: string; lasting: boolean }[] = [];
    const reported: string[] = [];
    const bindings = {
        showNotice: (message: string, lasting: boolean) => void notices.push({ message, lasting }),
        reportLoadedMainJs: (sha256: string) => void reported.push(sha256),
        waitForTeardown: () => Promise.resolve(),
        prepareForDowngrade: vi.fn(
            options.getQueueProcessor
                ? createQueueDowngradePreparation(options.getQueueProcessor)
                : async () => undefined
        ),
        isAppHidden: vi.fn(() => false),
        deviceLocalStorage: (key: string) =>
            options.withoutDeviceLocalStorage
                ? undefined
                : { load: () => localStorage.get(key), save: (value: string) => void localStorage.set(key, value) },
    };
    useReleaseInstall({ services } as never, plugin as never, bindings);
    const run = async (kind: keyof typeof handlers) => {
        for (const handler of handlers[kind]) expect(await handler()).toBe(true);
    };
    return {
        adapter,
        app,
        manager,
        plugin,
        plugins,
        vaultFiles,
        vaultListeners,
        readPackage,
        getFiles,
        services,
        lifecycle,
        logs,
        notices,
        reported,
        bindings,
        /** The plug-in loads its settings, and then the layout becomes ready. */
        start: async () => {
            await run("settingLoaded");
            await run("layoutReady");
        },
        loadSettings: () => run("settingLoaded"),
        folderBefore: adapter.snapshot(),
    };
}

const keysFileOf = (...keys: TestKey[]) => JSON.stringify({ format: 1, keys: keys.map((key) => key.spkiBase64) });
const newerPackage = async (key = KEY) => packageBytesOf(await signedAfter(key, undefined, NEWER_RELEASE));

describe("without a trusted-keys file", () => {
    it("is off and silent: no package is read, nothing watches the vault, and nothing is installed", async () => {
        const host = createHost();
        host.vaultFiles.set("p.livesync-release", await newerPackage());

        await host.start();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(host.notices).toEqual([]);
        expect(host.getFiles).not.toHaveBeenCalled();
        expect(host.readPackage).not.toHaveBeenCalled();
        expect(host.app.vault.on).not.toHaveBeenCalled();
        expect(host.adapter.snapshot()).toEqual(host.folderBefore);
        expect(host.logs).toEqual([
            expect.stringContaining(
                `Installing releases from the vault is off (no ${TRUSTED_RELEASE_KEYS_FILE} beside the plug-in). Running release: ${RUNNING_RELEASE_NUMBER}.`
            ),
        ]);
    });
});

describe("with a trusted-keys file which is not valid", () => {
    it.each<[string, () => string | Uint8Array<ArrayBuffer>]>([
        ["is empty", () => ""],
        ["is not JSON", () => "{"],
        ["holds an additional field", () => JSON.stringify({ format: 1, keys: [KEY.spkiBase64], note: "x" })],
        ["holds a key which is not one", () => JSON.stringify({ format: 1, keys: ["AAAA"] })],
        ["is not UTF-8", () => new Uint8Array([0xff, 0xfe])],
    ])("is off and says so once when the file %s", async (_, makeFile) => {
        const host = createHost({ keysFile: makeFile() });
        host.vaultFiles.set("p.livesync-release", await newerPackage());

        await host.start();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(host.notices).toEqual([
            {
                message: expect.stringContaining(
                    `Installing releases from the vault is off: ${TRUSTED_RELEASE_KEYS_FILE} is not valid`
                ),
                lasting: true,
            },
        ]);
        expect(host.readPackage).not.toHaveBeenCalled();
        expect(host.app.vault.on).not.toHaveBeenCalled();
        expect(host.adapter.snapshot()).toEqual(host.folderBefore);
        expect(host.logs[host.logs.length - 1]).toContain("is off (");
    });
});

describe("with trusted keys", () => {
    it.each([
        "install",
        "rollback-after-conversion",
        "rollback-before-database",
        "unload-throws",
        "unload-stays",
        "unloaded-registry-throws",
        "unloaded-registry-stays",
        "rollback-unload-throws",
        "rollback-unload-stays",
        "rollback-unloaded-registry-throws",
        "rollback-unloaded-registry-stays",
    ] as const)(
        "preserves a legacy-readable queue through the production binding and persistent store (%s)",
        async (outcome) => {
            const unloadRefused = outcome.includes("unload");
            const rollback = outcome.startsWith("rollback-");
            const terminal = outcome.includes("unloaded-registry");
            let storeClosed = false;
            let writesAfterClose = 0;
            const directory = mkdtempSync(join(tmpdir(), "livesync-release-queue-"));
            const openStore = (): QueueSnapshotStore => ({
                get: async <T>(key: string) => {
                    try {
                        return JSON.parse(readFileSync(join(directory, encodeURIComponent(key)), "utf8")) as T;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined as T;
                        throw error;
                    }
                },
                set: async (key, value) => {
                    if (storeClosed) {
                        writesAfterClose++;
                        return;
                    }
                    const file = join(directory, encodeURIComponent(key));
                    writeFileSync(`${file}.incoming`, JSON.stringify(value));
                    renameSync(`${file}.incoming`, file);
                },
                del: async (key) => {
                    rmSync(join(directory, encodeURIComponent(key)), { force: true });
                },
                keys: async () => readdirSync(directory).map(decodeURIComponent),
            });
            let processor!: ReplicateResultProcessor;
            const host = createHost({ keysFile: keysFileOf(KEY), getQueueProcessor: () => processor });
            const applied = vi.fn(async () => true);
            const makeProcessor = (store: QueueSnapshotStore) => {
                const services = {
                    ...host.services,
                    appLifecycle: {
                        ...host.services.appLifecycle,
                        isReady: () => host.lifecycle.ready && !host.lifecycle.unloaded,
                        isSuspended: () => host.lifecycle.unloaded,
                    },
                    path: { getPath: (doc: { path: string }) => doc.path },
                    vault: { isTargetFile: async () => true, isFileSizeTooLarge: () => false, isValidPath: () => true },
                    replication: {
                        ...host.services.replication,
                        processVirtualDocument: async () => false,
                        processOptionalSynchroniseResult: async () => false,
                        processSynchroniseResult: applied,
                    },
                    replicator: { ...host.services.replicator, peekActiveReplicator: () => undefined },
                };
                const core = {
                    services,
                    kvDB: store,
                    localDatabase: {
                        getRaw: async (id: string) => ({ _id: id, _rev: "1-test" }),
                        getDBEntryFromMeta: async (doc: object) => ({ ...doc, data: "synthetic" }),
                    },
                    serviceModules: { storageAccess: { stat: async () => null } },
                };
                const result = new ReplicateResultProcessor({ core, settings: {} } as never);
                if (!unloadRefused) result.suspend();
                return result;
            };
            const note = (index: number) => ({
                _id: `waiting-${index}`,
                _rev: "1-test",
                path: `waiting-${index}.md`,
                type: "plain",
                datatype: "plain",
                mtime: 2,
                ctime: 1,
                size: 1,
                children: [],
                eden: {},
            });
            const waiting = Array.from({ length: 1205 }, (_, index) => note(index));
            const notices = waiting.slice(0, 5).map((doc) => doc._id);
            const readLegacy = async () => {
                const snapshot = await openStore().get<{
                    queued: unknown[];
                    processing: unknown[];
                    waiting: typeof waiting;
                    waitingWithoutNotice: string[];
                    documentRecords?: boolean;
                }>(QUEUE_SNAPSHOT_KEY);
                expect(snapshot.documentRecords).toBeUndefined();
                expect(snapshot.queued).toEqual([]);
                expect(snapshot.processing).toEqual([]);
                expect(snapshot.waiting).toEqual(waiting);
                expect(snapshot.waitingWithoutNotice).toEqual(notices);
            };
            let candidate: ReplicateResultProcessor | undefined;
            try {
                await openStore().set(QUEUE_SNAPSHOT_KEY, {
                    queued: [],
                    processing: [],
                    waiting,
                    waitingWithoutNotice: notices,
                });
                processor = makeProcessor(openStore());
                await processor.restoreFromSnapshotOnce();
                const take = (queue: ReplicateResultProcessor) =>
                    (queue as unknown as { _takeSnapshot(): Promise<void> })._takeSnapshot();
                await take(processor);
                expect((await openStore().get<{ documentRecords: boolean }>(QUEUE_SNAPSHOT_KEY)).documentRecords).toBe(
                    true
                );
                host.manager.unloadPlugin.mockImplementation(async (id) => {
                    await take(candidate ?? processor);
                    await new Promise((resolve) => setTimeout(resolve, 70));
                    await readLegacy();
                    if (unloadRefused && (!rollback || candidate)) {
                        if (terminal) {
                            host.lifecycle.unloaded = true;
                            storeClosed = true;
                        }
                        if (outcome.endsWith("throws")) throw new Error("synthetic unload refused");
                        return;
                    }
                    delete host.plugins[id];
                });
                host.manager.loadPlugin.mockImplementation(async (id) => {
                    await readLegacy();
                    const instance = loadSyntheticBuild(
                        host.adapter.files.get(pluginFile("main.js"))
                    ) as SyntheticInstance;
                    host.plugins[id] = instance;
                    if (instance.securityRelease.releaseNumber === NEWER_RELEASE && rollback) {
                        candidate = makeProcessor(openStore());
                        if (outcome !== "rollback-before-database") {
                            await candidate.restoreFromSnapshotOnce();
                            await take(candidate);
                            expect(
                                (await openStore().get<{ documentRecords: boolean }>(QUEUE_SNAPSHOT_KEY))
                                    .documentRecords
                            ).toBe(true);
                        } else
                            Object.defineProperty(candidate.core, "kvDB", {
                                get() {
                                    throw new Error("database not initialised");
                                },
                            });
                        Object.assign(instance.securityRelease, {
                            loadState: "failed",
                            prepareForDowngrade: createQueueDowngradePreparation(() => candidate!),
                        });
                    }
                });
                host.vaultFiles.set("releases/queue.livesync-release", await newerPackage());
                await host.start();
                await vi.waitFor(() => expect(host.notices.length).toBe(1), { timeout: 15000 });
                if (unloadRefused) {
                    const running = candidate ?? processor;
                    if (terminal) {
                        expect(
                            (running as unknown as { _snapshotPinnedForDowngrade: boolean })._snapshotPinnedForDowngrade
                        ).toBe(true);
                        expect(running.isSuspended).toBe(true);
                        await take(running);
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        expect(writesAfterClose).toBe(0);
                        expect(applied).toHaveBeenCalledTimes(0);
                        await readLegacy();
                        return;
                    }
                    expect(
                        (running as unknown as { _snapshotPinnedForDowngrade: boolean })._snapshotPinnedForDowngrade
                    ).toBe(false);
                    expect(running.isSuspended).toBe(false);
                    if (rollback)
                        expect((host.plugins[TEST_PLUGIN_ID] as SyntheticInstance).securityRelease.releaseNumber).toBe(
                            NEWER_RELEASE
                        );
                    else expect(host.plugins[TEST_PLUGIN_ID]).toBe(host.plugin);
                    running.enqueueAll([note(9999)] as never);
                    await vi.waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
                    await vi.waitFor(() =>
                        expect(
                            (running as unknown as { _processingChanges: unknown[] })._processingChanges.length
                        ).toBe(0)
                    );
                    running.suspend();
                    running.enqueueAll([note(9998)] as never);
                    await take(running);
                    const reopened = makeProcessor(openStore());
                    reopened.suspend();
                    await reopened.restoreFromSnapshotOnce();
                    const queued = reopened as unknown as {
                        _queuedChanges: { values(): IterableIterator<{ _id: string }> };
                    };
                    expect([...queued._queuedChanges.values()].map((doc) => doc._id)).toEqual(["waiting-9998"]);
                    expect(
                        (await openStore().get<{ documentRecords: boolean }>(QUEUE_SNAPSHOT_KEY)).documentRecords
                    ).toBe(true);
                    return;
                }
                await readLegacy();
                expect((host.plugins[TEST_PLUGIN_ID] as SyntheticInstance).securityRelease.releaseNumber).toBe(
                    outcome === "install" ? NEWER_RELEASE : RUNNING_RELEASE_NUMBER
                );
                expect(host.notices[0].message).toContain(
                    outcome === "install" ? "installed release" : "previous release was put back"
                );
                expect(host.manager.unloadPlugin.mock.calls.length).toBe(outcome === "install" ? 1 : 2);
            } finally {
                processor?.suspend();
                candidate?.suspend();
                await new Promise((resolve) => setTimeout(resolve, 100));
                const inside = relative(tmpdir(), directory);
                expect(inside.startsWith("livesync-release-queue-")).toBe(true);
                rmSync(directory, { recursive: true });
            }
        },
        20000
    );

    it("exposes queue export for rollback before layout readiness and passes it to the installer", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        expect(Reflect.get(host.plugin.securityRelease, "prepareForDowngrade")).toBe(host.bindings.prepareForDowngrade);
        host.vaultFiles.set("releases/next.livesync-release", await newerPackage());
        await host.start();
        await vi.waitFor(() => expect(host.manager.unloadPlugin).toHaveBeenCalled(), { timeout: 10_000 });
        expect(host.bindings.prepareForDowngrade).toHaveBeenCalledTimes(1);
    });
    it("writes one log line with the state, the identifiers of the keys and the running release", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY, OTHER_KEY) });

        await host.loadSettings();

        expect(host.logs).toEqual([
            expect.stringContaining(
                `Installing releases from the vault is on, trusted keys: ${KEY.keyId}, ${OTHER_KEY.keyId}. Running release: ${RUNNING_RELEASE_NUMBER}.`
            ),
        ]);
        expect(host.notices).toEqual([]);
    });

    it("installs a valid newer package from the vault when the layout is ready, and reloads", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        host.vaultFiles.set("releases/next.livesync-release", await newerPackage());

        await host.start();
        await vi.waitFor(() => expect(host.notices).toHaveLength(1), { timeout: 10_000, interval: 50 });

        expect(host.notices[0]).toEqual({
            message: expect.stringContaining(`installed release 0.0.1-security.${NEWER_RELEASE}`),
            lasting: false,
        });
        const files = testFiles(NEWER_RELEASE);
        for (const name of ["main.js", "manifest.json", "styles.css"] as const) {
            expect(host.adapter.files.get(pluginFile(name))).toEqual(files[name]);
        }
        const instance = host.plugins[TEST_PLUGIN_ID] as SyntheticInstance;
        expect(instance).not.toBe(host.plugin);
        expect(instance.securityRelease).toEqual({ releaseNumber: NEWER_RELEASE, loadState: "loaded" });
        // The trust file, the settings and the package file are as they were.
        expect(encodeBase64(host.adapter.files.get(pluginFile(TRUSTED_RELEASE_KEYS_FILE))!)).toBe(
            host.folderBefore[pluginFile(TRUSTED_RELEASE_KEYS_FILE)]
        );
        expect(encodeBase64(host.adapter.files.get(pluginFile("data.json"))!)).toBe(
            host.folderBefore[pluginFile("data.json")]
        );
        // The swap used the transient unload/load, and never the persisting pair, so the plug-in stays enabled:
        // a crash in the swap window would still load a build on the next start.
        expect(host.manager.unloadPlugin).toHaveBeenCalledExactlyOnceWith(TEST_PLUGIN_ID);
        expect(host.manager.disablePlugin).not.toHaveBeenCalled();
        expect(host.manager.enabledPlugins.has(TEST_PLUGIN_ID)).toBe(true);
    }, 15_000);

    it("does not swap while a replication runs or the mobile app is hidden", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY), isMobile: true });
        host.vaultFiles.set("next.livesync-release", await newerPackage());
        host.services.replicator.boundedRemoteActivityCount.value = 1;
        host.bindings.isAppHidden.mockReturnValue(true);

        await host.start();
        // Staged and backed up, and then waiting.
        await vi.waitFor(() => expect(host.adapter.files.has(pluginFile("main.js.previous"))).toBe(true), {
            timeout: 5000,
        });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(host.manager.unloadPlugin).not.toHaveBeenCalled();
        host.services.replicator.boundedRemoteActivityCount.value = 0;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(host.manager.unloadPlugin).not.toHaveBeenCalled();

        host.bindings.isAppHidden.mockReturnValue(false);

        await vi.waitFor(() => expect(host.notices).toHaveLength(1), { timeout: 10_000, interval: 50 });
        expect(host.notices[0].message).toContain("installed release");
    }, 30_000);

    it.each<[string, (host: ReturnType<typeof createHost>, busy: boolean) => void]>([
        [
            "received documents are being applied",
            (host, busy) => void (host.services.replicator.boundedLocalApplicationActivityCount.value = busy ? 1 : 0),
        ],
        [
            "received documents are queued or being written to storage",
            (host, busy) => {
                host.services.replication.databaseQueueCount.value = busy ? 1 : 0;
                host.services.replication.storageApplyingCount.value = busy ? 1 : 0;
            },
        ],
        [
            "storage events are batched or being processed",
            (host, busy) => {
                host.services.fileProcessing.batched.value = busy ? 1 : 0;
                host.services.fileProcessing.processing.value = busy ? 1 : 0;
            },
        ],
    ])(
        "waits while %s, each wired into the idle check",
        async (_, setBusy) => {
            const host = createHost({ keysFile: keysFileOf(KEY) });
            host.vaultFiles.set("next.livesync-release", await newerPackage());
            setBusy(host, true);

            await host.start();
            await vi.waitFor(() => expect(host.adapter.files.has(pluginFile("main.js.previous"))).toBe(true), {
                timeout: 5000,
            });
            await new Promise((resolve) => setTimeout(resolve, 2500));
            expect(host.manager.unloadPlugin).not.toHaveBeenCalled();

            setBusy(host, false);

            await vi.waitFor(() => expect(host.notices).toHaveLength(1), { timeout: 10_000, interval: 50 });
            expect(host.notices[0].message).toContain("installed release");
        },
        30_000
    );

    it("does not unload the plug-in while it is not ready yet, so start-up is not cut short", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        host.vaultFiles.set("next.livesync-release", await newerPackage());
        host.lifecycle.ready = false;

        await host.start();
        await vi.waitFor(() => expect(host.adapter.files.has(pluginFile("main.js.previous"))).toBe(true), {
            timeout: 5000,
        });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(host.manager.unloadPlugin).not.toHaveBeenCalled();

        host.lifecycle.ready = true;

        await vi.waitFor(() => expect(host.notices).toHaveLength(1), { timeout: 10_000, interval: 50 });
        expect(host.notices[0].message).toContain("installed release");
    }, 30_000);

    it("rejects a package signed with a key which is not trusted here, and leaves the plug-in's files alone", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        host.vaultFiles.set("next.livesync-release", await newerPackage(OTHER_KEY));

        await host.start();
        await vi.waitFor(() => expect(host.notices).toHaveLength(1));

        expect(host.notices[0].message).toBe(
            "Release package next.livesync-release was rejected (unknown-key-id). Nothing was installed."
        );
        expect(host.adapter.snapshot()).toEqual(host.folderBefore);
        expect(host.manager.unloadPlugin).not.toHaveBeenCalled();
    });

    it("looks again, after a pause, when a package file is created, modified or renamed, and at nothing else", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        await host.start();
        await vi.waitFor(() => expect(host.getFiles).toHaveBeenCalledTimes(1));
        expect([...host.vaultListeners.keys()].sort()).toEqual(["create", "modify", "rename"]);
        expect(host.plugin.registerEvent).toHaveBeenCalledTimes(3);
        vi.useFakeTimers();

        host.vaultListeners.get("create")!({ path: "notes/a.md" });
        host.vaultListeners.get("modify")!({ path: "notes/release.livesync-release.md" });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(host.getFiles).toHaveBeenCalledTimes(1);

        // Several changes in quick succession lead to one look.
        host.vaultListeners.get("create")!({ path: "in/next.livesync-release" });
        await vi.advanceTimersByTimeAsync(1_000);
        host.vaultListeners.get("modify")!({ path: "in/next.LIVESYNC-RELEASE" });
        await vi.advanceTimersByTimeAsync(1_900);
        expect(host.getFiles).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(host.getFiles).toHaveBeenCalledTimes(2);

        // A rename away from the extension, or to it, counts too.
        host.vaultListeners.get("rename")!({ path: "in/next.txt" }, "in/next.livesync-release");
        await vi.advanceTimersByTimeAsync(2_100);
        expect(host.getFiles).toHaveBeenCalledTimes(3);
    });
});

describe("in an app without device-local storage", () => {
    it("is off, because a build which does not load could not be remembered", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY), withoutDeviceLocalStorage: true });
        host.vaultFiles.set("p.livesync-release", await newerPackage());

        await host.start();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(host.logs[host.logs.length - 1]).toContain(
            "is off (this version of the app offers no device-local storage)"
        );
        expect(host.readPackage).not.toHaveBeenCalled();
        expect(host.adapter.snapshot()).toEqual(host.folderBefore);
    });
});

describe("the running build", () => {
    it("is identified by the SHA-256 of the main.js on disk when the plug-in loads", async () => {
        const host = createHost();

        await host.loadSettings();

        expect(host.reported).toEqual([await sha256HexOf(host.adapter.files.get(pluginFile("main.js"))!)]);
    });

    it("stays unidentified, and loading goes on, when main.js cannot be read", async () => {
        const host = createHost({ keysFile: keysFileOf(KEY) });
        host.adapter.files.delete(pluginFile("main.js"));

        await host.loadSettings();

        expect(host.reported).toEqual([]);
        expect(host.logs[host.logs.length - 1]).toContain("is on, trusted keys");
    });
});

describe("the app's plug-in manager", () => {
    it.each([
        ["no plug-in manager", {}],
        ["a manager without unloadPlugin", { plugins: { loadPlugin: async () => {} } }],
        ["a manager without loadPlugin", { plugins: { unloadPlugin: async () => {} } }],
        ["a manager which is not an object", { plugins: "plugins" }],
    ])("is not usable with %s", (_, app) => {
        expect(releasePluginHostOf(app)).toBeUndefined();
    });

    it("unloads and loads through the transient methods, on the manager itself, in the same turn, awaited", async () => {
        const calls: unknown[][] = [];
        const manager = {
            plugins: { p: "instance" },
            unloadPlugin(this: unknown, id: string) {
                calls.push(["unloadPlugin", this === manager, id]);
            },
            loadPlugin(this: unknown, id: string) {
                calls.push(["loadPlugin", this === manager, id]);
                return Promise.resolve();
            },
        };
        const host = releasePluginHostOf({ plugins: manager })!;

        const unloading = host.disablePlugin("p");
        expect(calls).toEqual([["unloadPlugin", true, "p"]]);
        await unloading;
        await host.enablePlugin("p");

        expect(calls[1]).toEqual(["loadPlugin", true, "p"]);
        expect(host.getInstance("p")).toBe("instance");
        expect(host.getInstance("q")).toBeUndefined();
        expect(host.loadManifests).toBeUndefined();
    });

    it("never uses the persisting disable/enable, so a crash in the swap leaves the plug-in enabled", async () => {
        const enabledPlugins = new Set<string>(["p"]);
        const calls: string[] = [];
        const manager = {
            plugins: { p: "instance" },
            // The transient pair the swap must use: they do not touch the persisted enabled set.
            unloadPlugin: async (_id: string) => void calls.push("unloadPlugin"),
            loadPlugin: async (_id: string) => void calls.push("loadPlugin"),
            // The persisting pair: using either in the swap would clear the enabled set and defeat the restore.
            disablePlugin: async (id: string) => void (enabledPlugins.delete(id), calls.push("disablePlugin")),
            enablePlugin: async (id: string) => void (enabledPlugins.add(id), calls.push("enablePlugin")),
        };
        const host = releasePluginHostOf({ plugins: manager })!;

        // Model a crash in the swap window: the unload runs, the paired load never does.
        await host.disablePlugin("p");

        expect(calls).toEqual(["unloadPlugin"]);
        expect(enabledPlugins.has("p")).toBe(true);
    });

    it("reads the manifests again where the app offers it", async () => {
        const loadManifests = vi.fn(async () => undefined);
        const host = releasePluginHostOf({
            plugins: { unloadPlugin: async () => {}, loadPlugin: async () => {}, loadManifests },
        })!;

        await host.loadManifests?.();

        expect(loadManifests).toHaveBeenCalledOnce();
    });
});
