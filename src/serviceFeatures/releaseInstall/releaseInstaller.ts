/**
 * Installation of a verified release package into the plug-in's own folder.
 *
 * {@link prepareReleaseInstall} runs while the plug-in is loaded: it stages the new files and backs the current
 * ones up, and changes nothing which the running plug-in uses. {@link completeReleaseInstall} unloads the plug-in,
 * swaps the files, loads the new build and checks it, and puts the previous build back when that fails. It goes on
 * after the instance which started it has been unloaded, so this module uses nothing of the plug-in's services:
 * only the adapter, the host's plug-in manager, WebCrypto, timers and plain data handed to it.
 */
import { sha256Hex } from "./releaseBytes";
import type { ReleaseFileName, VerifiedReleasePackage } from "./releasePackage";

/** The part of the host's file adapter which an installation uses. Paths are relative to the vault. */
export interface ReleaseFileAdapter {
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}

/** The part of the host's plug-in manager which an installation uses. */
export interface ReleasePluginHost {
    /** Unloads a plug-in without recording it as disabled. */
    disablePlugin(pluginId: string): Promise<void>;
    /** Loads a plug-in from its folder. */
    enablePlugin(pluginId: string): Promise<void>;
    /** Reads the manifests of the installed plug-ins again, where the host offers it. */
    loadManifests?(): Promise<void>;
    /** The loaded instance of a plug-in, if there is one. */
    getInstance(pluginId: string): unknown;
}

/**
 * What every build exposes on its plug-in object as `securityRelease`. It is part of the installation protocol:
 * the build which installs a package reads it from the instance of the build it has just loaded, so its name and
 * shape must stay as they are.
 */
export interface PreparedDowngrade {
    /** Checked synchronously immediately before unloading; a changed queue requires another export. */
    isCurrent(): boolean;
    /** Releases the snapshot pin when installation has to wait for activity again. */
    cancel(): void;
}
export interface SecurityReleaseStatus {
    /** The release number which the build carries. */
    readonly releaseNumber: number;
    /** `loaded` once the plug-in has finished loading, `failed` when loading ended without success. */
    loadState: "loading" | "loaded" | "failed";
    /** Flushes the replicated-document queue to the snapshot shape an earlier build can read. */
    prepareForDowngrade?: () => Promise<PreparedDowngrade | void>;
}

/**
 * Run the loading of a plug-in instance and record in its status how it ended: `loaded` when `load` reports
 * success, `failed` when it reports failure or throws.
 * @returns What `load` returned.
 */
export async function trackLoadState(status: SecurityReleaseStatus, load: () => Promise<boolean>): Promise<boolean> {
    let loaded = false;
    try {
        loaded = await load();
    } finally {
        status.loadState = loaded ? "loaded" : "failed";
    }
    return loaded;
}

/**
 * Device-local memory of packages which must not be installed again: those whose installation was begun and
 * ended with the previous build put back. It must survive the plug-in's unload.
 */
export interface FailedReleaseRecords {
    rememberFailedToLoad(packageSha256: string): void;
}

export interface ReleaseInstallTimings {
    /** Pauses before a file whose read-back did not match is written and read again. */
    readBackRetryDelaysMs: readonly number[];
    /** How long the teardown of the unloaded instance may take before the installation goes on regardless. */
    teardownTimeoutMs: number;
    /** How long a build may take to load before it counts as not loading. */
    loadTimeoutMs: number;
    /** Pause between two looks at a build which is still loading. */
    loadPollMs: number;
}

/**
 * The first pauses follow the rewrite of a file which reads back as empty right after it was written, as some
 * mobile storage reports it; the later ones give storage which keeps reporting a stale size time to settle.
 * Together they bound one file to about 80 seconds.
 */
export const DEFAULT_RELEASE_INSTALL_TIMINGS: ReleaseInstallTimings = {
    readBackRetryDelaysMs: [200, 200, 200, 3_000, 15_000, 60_000],
    teardownTimeoutMs: 30_000,
    loadTimeoutMs: 60_000,
    loadPollMs: 100,
};

export interface ReleaseInstallEnvironment {
    adapter: ReleaseFileAdapter;
    host: ReleasePluginHost;
    subtle: SubtleCrypto;
    pluginId: string;
    /** The plug-in's own folder, relative to the vault. */
    pluginDirectory: string;
    /** The release number of the build which performs the installation. */
    runningReleaseNumber: number;
    /** The instance which performs the installation. A newly loaded build must be another one. */
    runningInstance: unknown;
    /** Resolves when the teardown of {@link runningInstance} has settled, once it has been unloaded. */
    waitForTeardown: () => Promise<unknown>;
    /** Runs while the current key-value database is still open, before the final idle check and unload. */
    prepareForDowngrade?: () => Promise<PreparedDowngrade | void>;
    records: FailedReleaseRecords;
    /** Tells the user. `lasting` messages stay until dismissed. */
    notify: (message: string, lasting: boolean) => void;
    wait: (milliseconds: number) => Promise<void>;
    timings: ReleaseInstallTimings;
}

interface PreparedFile {
    name: ReleaseFileName;
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
    previousBytes: Uint8Array<ArrayBuffer>;
    previousSha256: string;
}

/** A package whose files are staged beside the current ones, which are backed up. */
export interface PreparedReleaseInstall {
    releaseName: string;
    releaseNumber: number;
    /** SHA-256 of the package file, under which a build which does not load is remembered. */
    packageSha256: string;
    files: PreparedFile[];
}

export type ReleasePreparation =
    | { status: "prepared"; install: PreparedReleaseInstall }
    /** Nothing which the running plug-in uses was changed. `reason` is for the user. */
    | { status: "failed"; reason: string };

export type ReleaseInstallOutcome =
    | { status: "installed" }
    /** The host did not unload the running build, so no file was replaced and it is tried again at the next start. */
    | { status: "not-installed"; reason: string }
    /** The new build was not accepted; the previous build is back and running. */
    | { status: "restored"; reason: string }
    /** The new build was not accepted, and the previous build is not running either. */
    | { status: "restore-failed"; reason: string };

const STAGED_SUFFIX = ".incoming";
const BACKUP_SUFFIX = ".previous";
/** `main.js` is replaced last, so an interrupted swap leaves the code of the build which was running. */
const SWAP_ORDER: readonly ReleaseFileName[] = ["manifest.json", "styles.css", "main.js"];
/** `main.js` is put back first, so working code returns as early as possible. */
const RESTORE_ORDER: readonly ReleaseFileName[] = ["main.js", "manifest.json", "styles.css"];
/** Files without which the running plug-in could not have loaded; an empty read of one is not a backup. */
const NEVER_EMPTY: readonly ReleaseFileName[] = ["main.js", "manifest.json"];

const targetPath = (env: ReleaseInstallEnvironment, name: ReleaseFileName) => `${env.pluginDirectory}/${name}`;
const stagedPath = (env: ReleaseInstallEnvironment, name: ReleaseFileName) =>
    `${targetPath(env, name)}${STAGED_SUFFIX}`;
const backupPath = (env: ReleaseInstallEnvironment, name: ReleaseFileName) =>
    `${targetPath(env, name)}${BACKUP_SUFFIX}`;

function inOrder(files: readonly PreparedFile[], order: readonly ReleaseFileName[]): PreparedFile[] {
    return order.map((name) => files.find((file) => file.name === name) as PreparedFile);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function fileMatches(env: ReleaseInstallEnvironment, path: string, sha256: string): Promise<boolean> {
    try {
        return (await sha256Hex(env.subtle, new Uint8Array(await env.adapter.readBinary(path)))) === sha256;
    } catch {
        return false;
    }
}

/**
 * Write a file and read it back until what is read is what was written.
 *
 * A read-back which is empty, short or otherwise different is not trusted and not accepted: after a pause the file
 * is written and read again. When the pauses are used up the write has failed.
 */
async function writeVerified(
    env: ReleaseInstallEnvironment,
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    sha256: string
): Promise<boolean> {
    for (const pause of [0, ...env.timings.readBackRetryDelaysMs]) {
        if (pause > 0) await env.wait(pause);
        try {
            await env.adapter.writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        } catch {
            continue;
        }
        if (await fileMatches(env, path, sha256)) return true;
    }
    return false;
}

async function removeQuietly(env: ReleaseInstallEnvironment, path: string): Promise<void> {
    try {
        await env.adapter.remove(path);
    } catch {
        // The file is not there, which is what was wanted.
    }
}

async function removeStagedFiles(env: ReleaseInstallEnvironment): Promise<void> {
    for (const name of SWAP_ORDER) await removeQuietly(env, stagedPath(env, name));
}

/**
 * Stage the files of a verified package beside the current ones and back the current ones up.
 *
 * Every file written is read back and compared by SHA-256. Nothing which the running plug-in uses is changed, so
 * a failure here leaves the installed build exactly as it was.
 */
export async function prepareReleaseInstall(
    env: ReleaseInstallEnvironment,
    verified: VerifiedReleasePackage,
    packageSha256: string
): Promise<ReleasePreparation> {
    const fail = async (reason: string): Promise<ReleasePreparation> => {
        await removeStagedFiles(env);
        return { status: "failed", reason };
    };
    const files: PreparedFile[] = [];
    for (const file of verified.files) {
        if (!(await writeVerified(env, stagedPath(env, file.name), file.bytes, file.sha256))) {
            return await fail(`${file.name} could not be written and read back intact`);
        }
    }
    for (const file of verified.files) {
        let previousBytes: Uint8Array<ArrayBuffer>;
        try {
            previousBytes = new Uint8Array(await env.adapter.readBinary(targetPath(env, file.name)));
        } catch (error) {
            return await fail(`the installed ${file.name} could not be read (${describeError(error)})`);
        }
        if (previousBytes.length === 0 && NEVER_EMPTY.includes(file.name)) {
            return await fail(`the installed ${file.name} reads as empty`);
        }
        const previousSha256 = await sha256Hex(env.subtle, previousBytes);
        if (!(await writeVerified(env, backupPath(env, file.name), previousBytes, previousSha256))) {
            return await fail(`the installed ${file.name} could not be backed up and read back intact`);
        }
        files.push({ ...file, previousBytes, previousSha256 });
    }
    return {
        status: "prepared",
        install: {
            releaseName: verified.releaseName,
            releaseNumber: verified.releaseNumber,
            packageSha256,
            files,
        },
    };
}

/**
 * Put the staged file in the place of the installed one and make sure the result is the package's file.
 *
 * A rename which replaces an existing file in one step (the native desktop rename the host passes) leaves no moment
 * in which the file is absent. A rename which refuses an existing destination (the mobile adapter) is let fail, and
 * the installed file is then overwritten in place from the verified bytes in memory — never removed first. So no
 * kill point during the swap ever leaves the file absent: a crash before a file's write leaves the old file whole,
 * a crash during it leaves a partial but verified file the `.incoming`/`.previous` companions can recover, and a
 * crash after it leaves the whole new file. Whatever a rename leaves behind is checked, and a target which is not
 * yet the package's file is written from the verified bytes.
 */
async function replaceWithStaged(env: ReleaseInstallEnvironment, file: PreparedFile): Promise<void> {
    const target = targetPath(env, file.name);
    const staged = stagedPath(env, file.name);
    if (await fileMatches(env, staged, file.sha256)) {
        try {
            await env.adapter.rename(staged, target);
        } catch {
            // A rename which refuses an existing destination leaves the installed file in place; it is overwritten
            // below from the verified bytes, never removed first, so no crash point leaves the file missing.
        }
        if (await fileMatches(env, target, file.sha256)) return;
    }
    if (!(await writeVerified(env, target, file.bytes, file.sha256))) {
        throw new Error(`${file.name} could not be replaced`);
    }
}

async function swapFiles(env: ReleaseInstallEnvironment, install: PreparedReleaseInstall): Promise<void> {
    for (const file of inOrder(install.files, SWAP_ORDER)) await replaceWithStaged(env, file);
    // All three are read back once more, after the last of them is in place.
    for (const file of install.files) {
        if (!(await fileMatches(env, targetPath(env, file.name), file.sha256))) {
            throw new Error(`${file.name} does not read back as the package's file`);
        }
    }
}

/** Put the files which were installed before back, each checked against the hash taken when it was backed up. */
async function restoreFiles(env: ReleaseInstallEnvironment, install: PreparedReleaseInstall): Promise<boolean> {
    let restored = true;
    for (const file of inOrder(install.files, RESTORE_ORDER)) {
        const target = targetPath(env, file.name);
        if (await fileMatches(env, target, file.previousSha256)) continue;
        if (!(await writeVerified(env, target, file.previousBytes, file.previousSha256))) restored = false;
    }
    return restored;
}

function readSecurityRelease(instance: unknown): Partial<SecurityReleaseStatus> {
    const status: unknown =
        typeof instance === "object" && instance !== null ? Reflect.get(instance, "securityRelease") : undefined;
    return typeof status === "object" && status !== null ? status : {};
}

/** Whether `promise` settled within the time limit. A rejection counts as settled. */
async function settlesWithin(env: ReleaseInstallEnvironment, promise: Promise<unknown>, limitMs: number) {
    const settled = promise.then(
        () => true,
        () => true
    );
    return await Promise.race([settled, env.wait(limitMs).then(() => false)]);
}

/**
 * Load the plug-in from its folder and accept the result only if a new instance exists, is none of
 * `earlierInstances`, has finished loading, and reports exactly `releaseNumber`.
 * @returns `undefined` when the build is accepted, otherwise what was wrong with it.
 */
async function loadAndCheck(
    env: ReleaseInstallEnvironment,
    releaseNumber: number,
    earlierInstances: readonly unknown[]
): Promise<string | undefined> {
    try {
        await env.host.loadManifests?.();
    } catch {
        // The manifests in memory are then the earlier ones; the check below still decides.
    }
    let enabled = false;
    const enabling = env.host.enablePlugin(env.pluginId).then(
        () => (enabled = true),
        () => (enabled = true)
    );
    const polls = Math.ceil(env.timings.loadTimeoutMs / env.timings.loadPollMs);
    for (let poll = 0; poll <= polls; poll++) {
        const instance = env.host.getInstance(env.pluginId);
        if (instance !== undefined && instance !== null && !earlierInstances.includes(instance)) {
            const status = readSecurityRelease(instance);
            if (status.releaseNumber !== releaseNumber) {
                return `it reports release ${String(status.releaseNumber)} instead of ${releaseNumber}`;
            }
            if (status.loadState === "loaded") return undefined;
            if (status.loadState !== "loading") return "it did not finish loading";
        } else if (enabled) {
            return "the host did not load it";
        }
        const pause = env.wait(env.timings.loadPollMs);
        await (enabled ? pause : Promise.race([enabling, pause]));
    }
    return "it did not finish loading in time";
}

async function unloadQuietly(env: ReleaseInstallEnvironment): Promise<void> {
    try {
        await settlesWithin(env, env.host.disablePlugin(env.pluginId), env.timings.teardownTimeoutMs);
    } catch {
        // A missing build needs no unload; the caller checks for a surviving instance before replacing files.
    }
}

/**
 * The installation did not succeed: unload what there is of the new build, put the previous files back and load
 * the previous build again.
 *
 * The package is remembered and never tried again. The previous build looks at the vault as soon as it is loaded
 * again, so a package which was left to be tried again would be installed, and fail, over and over.
 */
async function restorePreviousBuild(
    env: ReleaseInstallEnvironment,
    install: PreparedReleaseInstall,
    reason: string
): Promise<ReleaseInstallOutcome> {
    const rejectedInstance = env.host.getInstance(env.pluginId);
    // Remembered before export or teardown can fail, so the rejected package is not retried after a restart.
    env.records.rememberFailedToLoad(install.packageSha256);
    let preparation: PreparedDowngrade | void = undefined;
    try {
        try {
            preparation = await readSecurityRelease(rejectedInstance).prepareForDowngrade?.();
            if (preparation && !preparation.isCurrent()) {
                throw new Error("The replication queue changed while preparing the previous build");
            }
        } catch (error) {
            // The previous build must never be loaded against a queue it cannot read.
            const problem = describeError(error);
            env.notify(problem, true);
            return { status: "restore-failed", reason: problem };
        }
        await unloadQuietly(env);
        if (rejectedInstance && env.host.getInstance(env.pluginId) === rejectedInstance) {
            const problem = "the host did not unload the running build";
            env.notify(problem, true);
            return { status: "restore-failed", reason: problem };
        }
        const filesRestored = await restoreFiles(env, install);
        await removeStagedFiles(env);
        const problem = filesRestored
            ? await loadAndCheck(env, env.runningReleaseNumber, [env.runningInstance, rejectedInstance])
            : "its files could not be put back";
        if (problem === undefined) {
            env.notify(
                `Release ${install.releaseName} from the vault was not installed: ${reason}. ` +
                    `The previous release was put back and is running. This package will not be tried again.`,
                true
            );
            return { status: "restored", reason };
        }
        env.notify(
            `Release ${install.releaseName} from the vault was not installed: ${reason}. ` +
                `The previous release could not be started again: ${problem}. ` +
                `Self-hosted LiveSync is not running; reinstall it manually.`,
            true
        );
        return { status: "restore-failed", reason };
    } finally {
        if (preparation && rejectedInstance && env.host.getInstance(env.pluginId) === rejectedInstance)
            preparation.cancel();
    }
}

async function finishInstall(
    env: ReleaseInstallEnvironment,
    install: PreparedReleaseInstall,
    unloading: Promise<unknown>
): Promise<ReleaseInstallOutcome> {
    await settlesWithin(env, unloading, env.timings.teardownTimeoutMs);
    // Files are replaced only under a build which the host no longer runs.
    if (env.host.getInstance(env.pluginId) === env.runningInstance) {
        await removeStagedFiles(env);
        const reason = "the host did not unload the running build";
        env.notify(
            `Release ${install.releaseName} from the vault was not installed: ${reason}. ` +
                `No file was replaced. Restart the app if synchronisation has stopped. ` +
                `It is tried again at the next start.`,
            true
        );
        return { status: "not-installed", reason };
    }
    await settlesWithin(env, env.waitForTeardown(), env.timings.teardownTimeoutMs);
    try {
        await swapFiles(env, install);
    } catch (error) {
        return await restorePreviousBuild(env, install, describeError(error));
    }
    const problem = await loadAndCheck(env, install.releaseNumber, [env.runningInstance]);
    if (problem !== undefined) {
        return await restorePreviousBuild(env, install, `the new build did not load: ${problem}`);
    }
    await removeStagedFiles(env);
    env.notify(`Self-hosted LiveSync installed release ${install.releaseName} from the vault and reloaded.`, false);
    return { status: "installed" };
}

/**
 * Unload the running plug-in, swap its files for the staged ones, load the new build and check it; put the
 * previous build back when any of that fails. Every outcome raises a notice.
 *
 * The unload is started before this function returns, so a caller which has just found the plug-in idle hands
 * over without anything running in between.
 */
export function completeReleaseInstall(
    env: ReleaseInstallEnvironment,
    install: PreparedReleaseInstall
): Promise<ReleaseInstallOutcome> {
    let unloading: Promise<unknown>;
    try {
        unloading = env.host.disablePlugin(env.pluginId);
    } catch (error) {
        unloading = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return finishInstall(env, install, unloading);
}
