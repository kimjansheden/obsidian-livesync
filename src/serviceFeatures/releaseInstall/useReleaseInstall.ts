/**
 * Installs signed releases which arrive as files in the vault: the binding of the release installation to the
 * Obsidian host. See `docs/release_install.md`.
 */
import type { App, EventRef, PluginManifest } from "obsidian";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { NecessaryServices } from "@vrtmrz/livesync-commonlib/compat/interfaces/ServiceModule";
import { createInstanceLogFunction } from "@vrtmrz/livesync-commonlib/compat/services/lib/logUtils";
import { compatGlobal, type CompatTimeoutHandle } from "@vrtmrz/livesync-commonlib/compat/common/coreEnvFunctions";
import { sha256Hex } from "./releaseBytes";
import {
    DEFAULT_RELEASE_INSTALL_COORDINATOR_TIMINGS,
    ReleaseInstallCoordinator,
    type ReleaseInstallActivity,
    type ReleasePackageFile,
} from "./releaseInstallCoordinator";
import {
    DEFAULT_RELEASE_INSTALL_TIMINGS,
    type ReleaseFileAdapter,
    type ReleaseInstallEnvironment,
    type ReleasePluginHost,
} from "./releaseInstaller";
import { createReleaseInstallRecords, type DeviceLocalStorage } from "./releaseInstallRecords";
import { RELEASE_PACKAGE_EXTENSION, type TrustedReleaseKey } from "./releasePackage";
import { RELEASE_MARKER_PREFIX, RUNNING_RELEASE_NUMBER } from "./runningRelease";
import { parseTrustedReleaseKeys, pluginDirectoryOf, TRUSTED_RELEASE_KEYS_FILE } from "./trustedReleaseKeys";

type ReleaseInstallHost = NecessaryServices<
    "API" | "appLifecycle" | "control" | "fileProcessing" | "replication" | "replicator",
    never
>;

/** The part of the plug-in object which the release installation uses. */
export interface ReleaseInstallPlugin {
    app: App;
    manifest: PluginManifest;
    registerEvent(eventRef: EventRef): void;
    register(callback: () => unknown): void;
}

export interface ReleaseInstallHostBindings {
    /** Shows a notice. `lasting` notices stay until dismissed. It must keep working after the plug-in unloads. */
    showNotice(message: string, lasting: boolean): void;
    /** Receives the SHA-256 of the `main.js` this instance was loaded from, for the report in the remote milestone. */
    reportLoadedMainJs(sha256: string): void;
    /** Resolves when the teardown of this instance has settled, once it has been unloaded. */
    waitForTeardown(): Promise<unknown>;
    /** Whether the application window is hidden. */
    isAppHidden(): boolean;
    /** Storage of this vault on this device under `key`, or `undefined` where the app does not offer it. */
    deviceLocalStorage(key: string): DeviceLocalStorage | undefined;
}

/** A desktop adapter which can rename through the native file system, replacing an existing destination in one step. */
interface NativeRenameAdapter {
    fsPromises?: { rename(from: string, to: string): Promise<void> };
    fs?: { rename(from: string, to: string): Promise<void> };
    getFullPath(path: string): string;
}

/** Device-local key under which rejected and failed packages are remembered for this vault. */
const RECORDS_STORAGE_KEY = "ols-release-install";
/** Quiet time after the last change to a package file before the vault is looked at. */
const PACKAGE_CHANGE_DEBOUNCE_MS = 2_000;

/**
 * The host's plug-in manager, when it can unload and load a plug-in without recording it as disabled.
 * @returns `undefined` when it cannot, so that nothing is installed which could not be reloaded and verified.
 */
export function releasePluginHostOf(app: object): ReleasePluginHost | undefined {
    const manager: unknown = Reflect.get(app, "plugins");
    if (typeof manager !== "object" || manager === null) return undefined;
    const method = (name: string) => {
        const candidate: unknown = Reflect.get(manager, name);
        if (typeof candidate !== "function") return undefined;
        // Called synchronously, so that an unload starts in the same turn in which it was decided.
        return (...args: unknown[]) => Promise.resolve(Reflect.apply(candidate, manager, args) as unknown);
    };
    // The swap unloads the running build and loads the next one with the transient methods the host's own reload
    // uses. `disablePlugin`/`enablePlugin` would persist the plug-in as disabled between the two steps, so a crash
    // in the swap window would leave it disabled on the next start and load no build at all; `unloadPlugin`/
    // `loadPlugin` leave the persisted enabled set untouched, so a crash still loads a build (new or restored).
    const unloadPlugin = method("unloadPlugin");
    const loadPlugin = method("loadPlugin");
    if (!unloadPlugin || !loadPlugin) return undefined;
    const loadManifests = method("loadManifests");
    return {
        disablePlugin: async (pluginId) => void (await unloadPlugin(pluginId)),
        enablePlugin: async (pluginId) => void (await loadPlugin(pluginId)),
        ...(loadManifests ? { loadManifests: async () => void (await loadManifests()) } : {}),
        getInstance: (pluginId) => {
            const plugins: unknown = Reflect.get(manager, "plugins");
            return typeof plugins === "object" && plugins !== null ? Reflect.get(plugins, pluginId) : undefined;
        },
    };
}

function isPackagePath(path: string): boolean {
    return path.toLowerCase().endsWith(`.${RELEASE_PACKAGE_EXTENSION}`);
}

export function useReleaseInstall(
    host: ReleaseInstallHost,
    plugin: ReleaseInstallPlugin,
    bindings: ReleaseInstallHostBindings
) {
    const log = createInstanceLogFunction("SF:ReleaseInstall", host.services.API);
    const { app } = plugin;
    const adapter = app.vault.adapter;
    const pluginDirectory = pluginDirectoryOf(plugin);
    const subtle = compatGlobal.crypto.subtle;
    const wait = (milliseconds: number) =>
        new Promise<void>((resolve) => void compatGlobal.setTimeout(resolve, milliseconds));
    const deviceLocalStorage = bindings.deviceLocalStorage(RECORDS_STORAGE_KEY);
    let coordinator: ReleaseInstallCoordinator | undefined;

    /**
     * The installer writes only its own three files, so it uses the adapter directly, past the guards which govern
     * synchronised content. On the desktop it renames through the native file system, which replaces an existing
     * file in one step, so the swap never leaves a file absent; a host without that (mobile) renames through the
     * vault adapter, which refuses an existing destination, so the installer removes it first.
     */
    function installFileAdapter(): ReleaseFileAdapter {
        const native =
            (adapter as Partial<NativeRenameAdapter>).fsPromises ?? (adapter as Partial<NativeRenameAdapter>).fs;
        const getFullPath = (adapter as Partial<NativeRenameAdapter>).getFullPath;
        const renamesNatively = typeof native?.rename === "function" && typeof getFullPath === "function";
        return {
            readBinary: (path) => adapter.readBinary(path),
            writeBinary: (path, data) => adapter.writeBinary(path, data),
            remove: (path) => adapter.remove(path),
            rename:
                renamesNatively && native && getFullPath
                    ? (from, to) => native.rename(getFullPath(from), getFullPath(to))
                    : (from, to) => adapter.rename(from, to),
        };
    }

    /**
     * The hash of the `main.js` on disk at load identifies the running build in the remote milestone.
     *
     * A build which is running cannot really be empty, but some mobile storage reads a file back as zero bytes for
     * a while after it was written. Rather than report the hash of nothing, read again with the same patience the
     * installer uses, and report nothing if it stays empty: a device without the field is simply not identified.
     */
    async function reportLoadedMainJs() {
        const path = `${pluginDirectory}/main.js`;
        for (const pause of [0, ...DEFAULT_RELEASE_INSTALL_TIMINGS.readBackRetryDelaysMs]) {
            if (pause > 0) await wait(pause);
            const mainJs = new Uint8Array(await adapter.readBinary(path));
            if (mainJs.length > 0) {
                bindings.reportLoadedMainJs(await sha256Hex(subtle, mainJs));
                return;
            }
        }
        log("The running build's main.js read back empty; its hash is not reported.", LOG_LEVEL_VERBOSE);
    }

    /**
     * Read the keys trusted on this device. Without the file the feature is off and says nothing; with a file
     * which is not valid it is off and says so.
     */
    async function readTrustedKeys(): Promise<{ keys?: TrustedReleaseKey[]; state: string }> {
        // Without device-local storage a package whose build does not load could not be remembered.
        if (!deviceLocalStorage) return { state: "off (this version of the app offers no device-local storage)" };
        // A build which does not know its own release number cannot tell which package is newer.
        if (!Number.isSafeInteger(RUNNING_RELEASE_NUMBER) || RUNNING_RELEASE_NUMBER <= 0) {
            return { state: "off (this build carries no release number)" };
        }
        const path = `${pluginDirectory}/${TRUSTED_RELEASE_KEYS_FILE}`;
        if (!(await adapter.exists(path))) return { state: `off (no ${TRUSTED_RELEASE_KEYS_FILE} beside the plug-in)` };
        let parsed: Awaited<ReturnType<typeof parseTrustedReleaseKeys>>;
        try {
            parsed = await parseTrustedReleaseKeys(new Uint8Array(await adapter.readBinary(path)), subtle);
        } catch {
            parsed = { status: "invalid", reason: "it could not be read" };
        }
        if (parsed.status === "invalid") {
            bindings.showNotice(
                `Installing releases from the vault is off: ${TRUSTED_RELEASE_KEYS_FILE} is not valid (${parsed.reason}).`,
                true
            );
            return { state: `off (${TRUSTED_RELEASE_KEYS_FILE} is not valid: ${parsed.reason})` };
        }
        return { keys: parsed.keys, state: `on, trusted keys: ${parsed.keys.map((key) => key.keyId).join(", ")}` };
    }

    function currentActivity(): ReleaseInstallActivity {
        const { replicator, replication, fileProcessing, appLifecycle, API } = host.services;
        const localApplication = Reflect.get(replicator, "boundedLocalApplicationActivityCount") as
            | { value: number }
            | undefined;
        // A replication which is being prepared counts here before it counts as finite remote activity; a host
        // without the count (an older Commonlib) contributes nothing for it.
        const replicationCycle = Reflect.get(replication, "replicationCycleCount") as { value: number } | undefined;
        return {
            ready: appLifecycle.isReady(),
            remoteActivities: replicator.boundedRemoteActivityCount.value + (replicationCycle?.value ?? 0),
            localApplicationActivities: localApplication?.value ?? 0,
            replicationResults:
                replication.replicationResultCount.value +
                replication.databaseQueueCount.value +
                replication.storageApplyingCount.value,
            fileEvents:
                fileProcessing.totalQueued.value + fileProcessing.batched.value + fileProcessing.processing.value,
            syncStatus: replicator.replicationStatics.value.syncStatus,
            hiddenOnMobile: API.isMobile() && bindings.isAppHidden(),
        };
    }

    function listPackageFiles(): ReleasePackageFile[] {
        return app.vault
            .getFiles()
            .filter((file) => isPackagePath(file.path))
            .map((file) => ({
                path: file.path,
                size: file.stat.size,
                read: async () => new Uint8Array(await app.vault.readBinary(file)),
            }));
    }

    function createCoordinator(
        trustedKeys: TrustedReleaseKey[],
        deviceLocalStorage: DeviceLocalStorage
    ): ReleaseInstallCoordinator {
        const notify = (message: string, lasting: boolean) => {
            // The log of an unloaded instance is gone, so the notice is the record of what happened then.
            if (!host.services.control.hasUnloaded()) log(message, LOG_LEVEL_INFO);
            bindings.showNotice(message, lasting);
        };
        const records = createReleaseInstallRecords(deviceLocalStorage);
        const pluginHost = releasePluginHostOf(app);
        const install: ReleaseInstallEnvironment | undefined = pluginHost && {
            adapter: installFileAdapter(),
            host: pluginHost,
            subtle,
            pluginId: plugin.manifest.id,
            pluginDirectory,
            runningReleaseNumber: RUNNING_RELEASE_NUMBER,
            runningInstance: plugin,
            waitForTeardown: () => bindings.waitForTeardown(),
            records,
            notify,
            wait,
            timings: DEFAULT_RELEASE_INSTALL_TIMINGS,
        };
        return new ReleaseInstallCoordinator({
            listPackageFiles,
            verification: {
                trustedKeys,
                pluginId: plugin.manifest.id,
                runningReleaseNumber: RUNNING_RELEASE_NUMBER,
                markerPrefix: RELEASE_MARKER_PREFIX,
                subtle,
            },
            records,
            install,
            currentActivity,
            storageEventCount: () => host.services.fileProcessing.totalStorageFileEventCount,
            hasUnloaded: () => host.services.control.hasUnloaded(),
            notify,
            log: (message) => log(message, LOG_LEVEL_VERBOSE),
            wait,
            timings: DEFAULT_RELEASE_INSTALL_COORDINATOR_TIMINGS,
        });
    }

    function lookAtVault() {
        coordinator?.scan().catch((error: unknown) => {
            log(`Looking for release packages failed: ${String(error)}`, LOG_LEVEL_INFO);
        });
    }

    /** Look again when a package file is created, modified or renamed, once the changes have settled. */
    function watchPackageFiles() {
        let pending: CompatTimeoutHandle | undefined;
        const onChange = (...paths: string[]) => {
            if (!paths.some(isPackagePath)) return;
            compatGlobal.clearTimeout(pending);
            pending = compatGlobal.setTimeout(lookAtVault, PACKAGE_CHANGE_DEBOUNCE_MS);
        };
        plugin.registerEvent(app.vault.on("create", (file) => onChange(file.path)));
        plugin.registerEvent(app.vault.on("modify", (file) => onChange(file.path)));
        plugin.registerEvent(app.vault.on("rename", (file, oldPath) => onChange(file.path, oldPath)));
        plugin.register(() => compatGlobal.clearTimeout(pending));
    }

    host.services.appLifecycle.onSettingLoaded.addHandler(async () => {
        // Loading goes on whatever happens here.
        try {
            await reportLoadedMainJs();
        } catch (error) {
            log(`The running build could not be identified: ${String(error)}`, LOG_LEVEL_VERBOSE);
        }
        try {
            const { keys, state } = await readTrustedKeys();
            log(
                `Installing releases from the vault is ${state}. Running release: ${RUNNING_RELEASE_NUMBER}.`,
                LOG_LEVEL_INFO
            );
            if (keys && deviceLocalStorage) coordinator = createCoordinator(keys, deviceLocalStorage);
        } catch (error) {
            log(`Installing releases from the vault is off: ${String(error)}`, LOG_LEVEL_INFO);
        }
        return true;
    });
    host.services.appLifecycle.onLayoutReady.addHandler(() => {
        // With the feature off nothing watches the vault, and no package file is read.
        if (coordinator) {
            watchPackageFiles();
            lookAtVault();
        }
        return Promise.resolve(true);
    });
}
