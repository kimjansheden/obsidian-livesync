import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { releasePluginHostOf, useReleaseInstall } from "./useReleaseInstall";
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
    const manager = {
        plugins,
        disablePlugin: vi.fn(async (id: string) => {
            delete plugins[id];
        }),
        enablePlugin: vi.fn(async (id: string) => {
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
        expect(host.manager.disablePlugin).toHaveBeenCalledExactlyOnceWith(TEST_PLUGIN_ID);
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
        expect(host.manager.disablePlugin).not.toHaveBeenCalled();
        host.services.replicator.boundedRemoteActivityCount.value = 0;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(host.manager.disablePlugin).not.toHaveBeenCalled();

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
            expect(host.manager.disablePlugin).not.toHaveBeenCalled();

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
        expect(host.manager.disablePlugin).not.toHaveBeenCalled();

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
        expect(host.manager.disablePlugin).not.toHaveBeenCalled();
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
        ["a manager without disablePlugin", { plugins: { enablePlugin: async () => {} } }],
        ["a manager without enablePlugin", { plugins: { disablePlugin: async () => {} } }],
        ["a manager which is not an object", { plugins: "plugins" }],
    ])("is not usable with %s", (_, app) => {
        expect(releasePluginHostOf(app)).toBeUndefined();
    });

    it("is called on the manager itself, in the same turn, and its results are awaited", async () => {
        const calls: unknown[][] = [];
        const manager = {
            plugins: { p: "instance" },
            disablePlugin(this: unknown, id: string) {
                calls.push(["disablePlugin", this === manager, id]);
            },
            enablePlugin(this: unknown, id: string) {
                calls.push(["enablePlugin", this === manager, id]);
                return Promise.resolve();
            },
        };
        const host = releasePluginHostOf({ plugins: manager })!;

        const unloading = host.disablePlugin("p");
        expect(calls).toEqual([["disablePlugin", true, "p"]]);
        await unloading;
        await host.enablePlugin("p");

        expect(calls[1]).toEqual(["enablePlugin", true, "p"]);
        expect(host.getInstance("p")).toBe("instance");
        expect(host.getInstance("q")).toBeUndefined();
        expect(host.loadManifests).toBeUndefined();
    });

    it("reads the manifests again where the app offers it", async () => {
        const loadManifests = vi.fn(async () => undefined);
        const host = releasePluginHostOf({
            plugins: { disablePlugin: async () => {}, enablePlugin: async () => {}, loadManifests },
        })!;

        await host.loadManifests?.();

        expect(loadManifests).toHaveBeenCalledOnce();
    });
});
