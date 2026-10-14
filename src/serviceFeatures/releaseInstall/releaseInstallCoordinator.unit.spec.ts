import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    isIdleForInstall,
    ReleaseInstallCoordinator,
    type ReleaseInstallActivity,
    type ReleaseInstallPorts,
    type ReleasePackageFile,
} from "./releaseInstallCoordinator";
import type { ReleaseInstallEnvironment } from "./releaseInstaller";
import { createReleaseInstallRecords, MAX_RELEASE_INSTALL_RECORDS } from "./releaseInstallRecords";
import {
    bytesOf,
    encodeBase64,
    generateTestKey,
    installSyntheticBuild,
    loadSyntheticBuild,
    mainJsOf,
    markerOf,
    MemoryAdapter,
    packageBytesOf,
    pluginFile,
    replaceBytes,
    sha256HexOf,
    signedAfter,
    subtle,
    SyntheticPluginHost,
    TEST_PLUGIN_DIRECTORY,
    TEST_PLUGIN_ID,
    testFiles,
    verificationContext,
    type SyntheticInstance,
    type TestKey,
    type TestPackage,
} from "./_releaseTestKit";

const RUNNING_RELEASE = 5;
const FILE_NAMES = ["main.js", "manifest.json", "styles.css"] as const;
const IDLE: ReleaseInstallActivity = {
    ready: true,
    remoteActivities: 0,
    localApplicationActivities: 0,
    replicationResults: 0,
    fileEvents: 0,
    syncStatus: "COMPLETED",
    hiddenOnMobile: false,
};

let KEY: TestKey;
let OTHER_KEY: TestKey;
beforeAll(async () => {
    KEY = await generateTestKey();
    OTHER_KEY = await generateTestKey();
});

/** A signed package of `releaseNumber` whose build and marker agree. */
async function packageOf(
    releaseNumber: number,
    key = KEY,
    change: (p: TestPackage) => void | Promise<void> = () => {}
): Promise<Uint8Array<ArrayBuffer>> {
    return packageBytesOf(await signedAfter(key, change, releaseNumber));
}

function createDevice(options: { canReload?: boolean } = {}) {
    const adapter = new MemoryAdapter();
    installSyntheticBuild(adapter, RUNNING_RELEASE);
    const runningInstance = loadSyntheticBuild(adapter.files.get(pluginFile("main.js"))) as SyntheticInstance;
    const host = new SyntheticPluginHost(adapter, runningInstance);
    const notices: string[] = [];
    const logs: string[] = [];
    const waits: number[] = [];
    let stored: unknown;
    const records = createReleaseInstallRecords({ load: () => stored, save: (value) => void (stored = value) });
    /** The package files in the vault. A test replaces a file's content to model a file which is still arriving. */
    const vault = new Map<string, Uint8Array<ArrayBuffer>>();
    const reads: string[] = [];
    const state = { activity: { ...IDLE }, storageEvents: 0, unloaded: false, onWait: (_ms: number) => {} };
    const wait = async (milliseconds: number) => {
        waits.push(milliseconds);
        state.onWait(milliseconds);
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const install: ReleaseInstallEnvironment = {
        adapter,
        host,
        subtle,
        pluginId: TEST_PLUGIN_ID,
        pluginDirectory: TEST_PLUGIN_DIRECTORY,
        runningReleaseNumber: RUNNING_RELEASE,
        runningInstance,
        waitForTeardown: () => Promise.resolve(),
        records,
        notify: (message) => void notices.push(message),
        wait,
        timings: { readBackRetryDelaysMs: [1], teardownTimeoutMs: 50, loadTimeoutMs: 50, loadPollMs: 5 },
    };
    const ports: ReleaseInstallPorts = {
        listPackageFiles: (): ReleasePackageFile[] =>
            [...vault.keys()].map((path) => ({
                path,
                size: vault.get(path)!.length,
                read: () => {
                    reads.push(path);
                    return Promise.resolve(vault.get(path)!);
                },
            })),
        verification: verificationContext(KEY, { runningReleaseNumber: RUNNING_RELEASE }),
        records,
        install: options.canReload === false ? undefined : install,
        currentActivity: () => state.activity,
        storageEventCount: () => state.storageEvents,
        hasUnloaded: () => state.unloaded,
        notify: (message) => void notices.push(message),
        log: (message) => void logs.push(message),
        wait,
        timings: { incompleteRetryDelaysMs: [11, 12, 13], idlePollMs: 7, maxPackageBytes: 1024 * 1024 },
    };
    const pluginFiles = () =>
        Object.fromEntries(FILE_NAMES.map((name) => [name, encodeBase64(adapter.files.get(pluginFile(name))!)]));
    const filesBefore = pluginFiles();
    const folderBefore = adapter.snapshot();
    return {
        coordinator: new ReleaseInstallCoordinator(ports),
        ports,
        adapter,
        host,
        vault,
        reads,
        notices,
        logs,
        waits,
        records,
        state,
        runningInstance,
        pluginFiles,
        filesBefore,
        folderBefore,
    };
}

const releaseOf = (device: ReturnType<typeof createDevice>) =>
    (device.host.instance as SyntheticInstance).securityRelease.releaseNumber;

/** Asserts that nothing in the plug-in's folder changed and the build which was running still runs. */
function expectUntouched(device: ReturnType<typeof createDevice>) {
    expect(device.adapter.snapshot()).toEqual(device.folderBefore);
    expect(device.host.instance).toBe(device.runningInstance);
    expect(device.adapter.changedPaths()).toEqual([]);
}

describe("a valid newer package", () => {
    it("cancels an outdated queue export and prepares again before unload", async () => {
        const device = createDevice();
        device.vault.set("releases/new.livesync-release", await packageOf(7));
        let exports = 0;
        const cancel = vi.fn(() => expect(device.host.instance).toBe(device.runningInstance));
        device.ports.install!.prepareForDowngrade = async () => {
            const current = ++exports;
            return { isCurrent: () => current > 1, cancel };
        };
        expect(await device.coordinator.scan()).toEqual({ status: "installed" });
        expect(exports).toBe(2);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("exports pending documents before the first unload", async () => {
        const device = createDevice();
        device.vault.set("releases/new.livesync-release", await packageOf(7));
        const exportQueue = vi.fn(async () => {
            expect(device.host.instance).toBe(device.runningInstance);
            expect(device.adapter.operations).not.toContain("disablePlugin");
        });
        device.ports.install!.prepareForDowngrade = exportQueue;
        expect(await device.coordinator.scan()).toEqual({ status: "installed" });
        expect(exportQueue).toHaveBeenCalledTimes(1);
    });

    it("leaves the running build intact when its queue export crashes", async () => {
        const device = createDevice();
        device.vault.set("releases/new.livesync-release", await packageOf(7));
        device.ports.install!.prepareForDowngrade = async () => {
            throw new Error("synthetic export crash");
        };
        await device.coordinator.scan();
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.host.instance).toBe(device.runningInstance);
        expect(device.adapter.operations).not.toContain("disablePlugin");
    });

    it("rechecks activity and storage events after an export yielded", async () => {
        const device = createDevice();
        device.vault.set("releases/new.livesync-release", await packageOf(7));
        let exports = 0;
        device.ports.install!.prepareForDowngrade = async () => {
            if (++exports === 1) {
                device.state.storageEvents++;
                device.state.activity.fileEvents = 1;
            }
        };
        device.state.onWait = () => {
            if (exports < 2) expect(device.host.instance).toBe(device.runningInstance);
            device.state.activity.fileEvents = 0;
        };
        expect(await device.coordinator.scan()).toEqual({ status: "installed" });
        expect(exports).toBe(2);
    });

    it("is installed without any action on the device, and a notice says so", async () => {
        const device = createDevice();
        device.vault.set("releases/0.0.1-security.7.livesync-release", await packageOf(7));

        const outcome = await device.coordinator.scan();

        expect(outcome).toEqual({ status: "installed" });
        expect(releaseOf(device)).toBe(7);
        expect(device.pluginFiles()).toEqual(
            Object.fromEntries(Object.entries(testFiles(7)).map(([name, bytes]) => [name, encodeBase64(bytes)]))
        );
        expect(device.notices).toEqual([expect.stringContaining("installed release 0.0.1-security.7")]);
    });

    it("is recognised by its content, whatever the file is called", async () => {
        const device = createDevice();
        device.vault.set("renamed.livesync-release", await packageOf(7));

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });
    });

    it("never has its package file changed or removed", async () => {
        const device = createDevice();
        const bytes = await packageOf(7);
        device.vault.set("a.livesync-release", bytes);

        await device.coordinator.scan();

        expect([...device.vault]).toEqual([["a.livesync-release", bytes]]);
    });

    it("is the one with the highest release number among several", async () => {
        const device = createDevice();
        device.vault.set("b.livesync-release", await packageOf(8));
        device.vault.set("c.livesync-release", await packageOf(9));
        device.vault.set("a.livesync-release", await packageOf(7));
        device.vault.set("old.livesync-release", await packageOf(4));

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(releaseOf(device)).toBe(9);
        expect(device.notices).toEqual([expect.stringContaining("0.0.1-security.9")]);
    });
});

describe("packages which are not installed", () => {
    it.each<[string, string, () => Promise<Uint8Array<ArrayBuffer>>]>([
        ["signed with a key which is not trusted here", "unknown-key-id", () => packageOf(7, OTHER_KEY)],
        [
            "without a signature",
            "missing-signature",
            async () => {
                const { signature: _removed, ...unsigned } = await signedAfter(KEY, undefined, 7);
                return packageBytesOf(unsigned);
            },
        ],
        [
            "whose signature does not hold",
            "bad-signature",
            async () => {
                const signed = await signedAfter(KEY, undefined, 7);
                signed.releaseNumber = 8;
                return packageBytesOf(signed);
            },
        ],
        [
            "with a file which does not match its SHA-256",
            "file-hash-mismatch",
            () =>
                packageOf(7, KEY, (p) => {
                    const bytes = Buffer.from(p.files[0].content, "base64");
                    bytes[0] ^= 0x01;
                    p.files[0].content = bytes.toString("base64");
                }),
        ],
        [
            "with a changed file whose hash was corrected after signing",
            "bad-signature",
            async () => {
                const signed = await signedAfter(KEY, undefined, 7);
                await replaceBytes(signed.files[0], mainJsOf(`changed ${markerOf(7)}`));
                return packageBytesOf(signed);
            },
        ],
        ["for another plug-in", "wrong-plugin-id", () => packageOf(7, KEY, (p) => void (p.pluginId = "other-plugin"))],
        [
            "whose manifest belongs to another plug-in",
            "wrong-manifest-id",
            () => packageOf(7, KEY, (p) => replaceBytes(p.files[1], bytesOf('{"id":"other-plugin"}'))),
        ],
        [
            "whose build carries another release number than it states",
            "release-marker-mismatch",
            () => packageOf(7, KEY, (p) => void (p.releaseNumber = 9)),
        ],
    ])("rejects a package %s, with a notice, and writes nothing", async (_, code, makePackage) => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await makePackage());

        await expect(device.coordinator.scan()).resolves.toBeUndefined();

        expect(device.notices).toEqual([
            `Release package p.livesync-release was rejected (${code}). Nothing was installed.`,
        ]);
        expectUntouched(device);
    });

    it.each([
        ["an older release", 4],
        ["the release which is running", RUNNING_RELEASE],
    ])("passes over %s without a notice, and writes nothing", async (_, releaseNumber) => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(releaseNumber));

        await expect(device.coordinator.scan()).resolves.toBeUndefined();

        expect(device.notices).toEqual([]);
        expectUntouched(device);
    });

    it("raises the notice for a rejected package once on this device, not at every look or start", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7, OTHER_KEY));

        await device.coordinator.scan();
        await device.coordinator.scan();
        // A later start: another coordinator over the same device-local records.
        await new ReleaseInstallCoordinator(device.ports).scan();

        expect(device.notices).toHaveLength(1);
        expectUntouched(device);
    });

    it("verifies a rejected package again at every look, so a key which becomes trusted is honoured", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7, OTHER_KEY));
        await device.coordinator.scan();

        device.ports.verification = { ...device.ports.verification, trustedKeys: [KEY.trusted, OTHER_KEY.trusted] };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });
    });

    it("raises one notice for each distinct rejected content", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7, OTHER_KEY));
        await device.coordinator.scan();
        device.vault.set("p.livesync-release", await packageOf(8, OTHER_KEY));

        await device.coordinator.scan();

        expect(device.notices).toHaveLength(2);
    });

    it("refuses a file above the size limit without reading it", async () => {
        const device = createDevice();
        device.ports.timings = { ...device.ports.timings, maxPackageBytes: 16 };
        device.vault.set("huge.livesync-release", await packageOf(7));

        await device.coordinator.scan();
        await device.coordinator.scan();

        expect(device.reads).toEqual([]);
        expect(device.notices).toEqual([expect.stringContaining("larger than 16 bytes")]);
        expectUntouched(device);
    });

    it("does not install where the host cannot unload and load a plug-in, and says so once", async () => {
        const device = createDevice({ canReload: false });
        device.vault.set("p.livesync-release", await packageOf(7));

        await device.coordinator.scan();
        await device.coordinator.scan();

        expect(device.notices).toEqual([expect.stringContaining("cannot unload and load a plug-in")]);
        expectUntouched(device);
    });

    it("installs a valid package beside rejected ones", async () => {
        const device = createDevice();
        device.vault.set("a.livesync-release", await packageOf(9, OTHER_KEY));
        device.vault.set("b.livesync-release", bytesOf("not a package"));
        device.vault.set("c.livesync-release", await packageOf(8));
        device.ports.timings = { ...device.ports.timings, incompleteRetryDelaysMs: [] };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(releaseOf(device)).toBe(8);
    });
});

describe("a package file which is not complete yet", () => {
    it.each([
        ["empty", new Uint8Array(0)],
        ["cut short", undefined],
    ])("is read again when it is %s, and installed without a notice once it is complete", async (_, partial) => {
        const device = createDevice();
        const complete = await packageOf(7);
        device.vault.set("p.livesync-release", partial ?? complete.slice(0, complete.length - 40));
        // The rest of the file arrives during the second pause.
        device.state.onWait = (milliseconds) => {
            if (milliseconds === 12) device.vault.set("p.livesync-release", complete);
        };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(device.waits.slice(0, 2)).toEqual([11, 12]);
        expect(device.notices).toEqual([expect.stringContaining("installed release")]);
    });

    it("is rejected, with one notice, only when it still does not parse after the last pause", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", bytesOf('{"format":1,'));

        await device.coordinator.scan();

        expect(device.waits).toEqual([11, 12, 13]);
        expect(device.notices).toEqual([
            "Release package p.livesync-release was rejected (invalid-json). Nothing was installed.",
        ]);
        // The same content is not waited for again.
        await device.coordinator.scan();
        expect(device.waits).toEqual([11, 12, 13]);
        expect(device.notices).toHaveLength(1);
        expectUntouched(device);
    });

    it("is not waited for when it is rejected for anything else", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7, OTHER_KEY));

        await device.coordinator.scan();

        expect(device.waits).toEqual([]);
    });
});

describe("waiting until the plug-in is idle", () => {
    it.each<[string, Partial<ReleaseInstallActivity>]>([
        ["a replication cycle runs", { remoteActivities: 1 }],
        ["received documents are being applied", { localApplicationActivities: 1 }],
        ["received documents are queued", { replicationResults: 2 }],
        ["file changes wait to be stored", { fileEvents: 1 }],
        ["a continuous replication transfers", { syncStatus: "CONNECTED" }],
        ["a journal is being sent", { syncStatus: "JOURNAL_SEND" }],
        ["a journal is being received", { syncStatus: "JOURNAL_RECEIVE" }],
        ["the mobile app is hidden", { hiddenOnMobile: true }],
        ["the plug-in is not ready yet", { ready: false }],
    ])("does not swap while %s, and installs once that has ended", async (_, busy) => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        device.state.activity = { ...IDLE, ...busy };
        let looks = 0;
        device.state.onWait = (milliseconds) => {
            if (milliseconds !== device.ports.timings.idlePollMs) return;
            // Staged and backed up, but nothing installed is touched while the plug-in is busy.
            expect(device.pluginFiles()).toEqual(device.filesBefore);
            expect(device.host.instance).toBe(device.runningInstance);
            expect(device.adapter.operations).not.toContain("disablePlugin");
            if (++looks === 5) device.state.activity = { ...IDLE };
        };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(looks).toBeGreaterThanOrEqual(5);
    });

    it("waits without an upper limit", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        device.state.activity = { ...IDLE, remoteActivities: 1 };
        let looks = 0;
        device.state.onWait = () => {
            if (++looks === 100) device.state.activity = { ...IDLE };
        };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(looks).toBeGreaterThanOrEqual(100);
    });

    it("needs two idle looks in a row with no storage event in between", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        let looks = 0;
        device.state.onWait = (milliseconds) => {
            if (milliseconds !== device.ports.timings.idlePollMs) return;
            expect(device.adapter.operations).not.toContain("disablePlugin");
            // A storage event arrives between each of the first three looks, without ever being counted as queued.
            if (++looks <= 3) device.state.storageEvents++;
        };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        expect(looks).toBe(4);
    });

    it("unloads in the same turn as its last idle look", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        const order: string[] = [];
        device.ports.currentActivity = () => {
            order.push("look");
            return device.state.activity;
        };
        const disable = device.host.disablePlugin;
        device.host.disablePlugin = (id) => {
            order.push("unload");
            // Nothing was awaited since the look: a microtask queued before it has not run yet.
            expect(microtaskRan).toBe(false);
            return disable(id);
        };
        let microtaskRan = false;
        const waitPort = device.ports.wait;
        device.ports.wait = async (milliseconds) => {
            await waitPort(milliseconds);
            microtaskRan = false;
            queueMicrotask(() => (microtaskRan = true));
        };

        await device.coordinator.scan();

        expect(order.slice(-2)).toEqual(["look", "unload"]);
    });

    it("does nothing more when the plug-in is unloaded by something else meanwhile", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        device.state.activity = { ...IDLE, remoteActivities: 1 };
        device.state.onWait = () => {
            device.state.unloaded = true;
            device.state.activity = { ...IDLE };
        };

        await expect(device.coordinator.scan()).resolves.toBeUndefined();

        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.adapter.operations).not.toContain("disablePlugin");
    });

    it("judges idleness by every kind of activity", () => {
        expect(isIdleForInstall(IDLE)).toBe(true);
        for (const syncStatus of ["NOT_CONNECTED", "PAUSED", "COMPLETED", "CLOSED", "ERRORED"]) {
            expect(isIdleForInstall({ ...IDLE, syncStatus })).toBe(true);
        }
        expect(isIdleForInstall({ ...IDLE, syncStatus: "STARTED" })).toBe(false);
        expect(isIdleForInstall({ ...IDLE, ready: false })).toBe(false);
    });
});

describe("staging which fails", () => {
    it("gives up with a notice, changes nothing, and is not tried again before the next start", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        // Fresh files read back as empty, as on some mobile storage, for longer than the installation waits.
        device.adapter.intercept.read = (path, stored) => (path.endsWith(".incoming") ? new Uint8Array(0) : stored);

        await expect(device.coordinator.scan()).resolves.toBeUndefined();
        await device.coordinator.scan();

        expect(device.notices).toEqual([
            "Release 0.0.1-security.7 from the vault was not installed: main.js could not be written and read back intact. Nothing was changed. It is tried again at the next start.",
        ]);
        expect(device.adapter.snapshot()).toEqual(device.folderBefore);
        expect(device.host.instance).toBe(device.runningInstance);
        // It is not a rejection of the package: the next start tries again, and succeeds once storage answers.
        device.adapter.intercept.read = undefined;
        await expect(new ReleaseInstallCoordinator(device.ports).scan()).resolves.toEqual({ status: "installed" });
    });
});

describe("a build which does not load", () => {
    it("ends with the previous build running on byte-identical files, and is never tried again", async () => {
        const device = createDevice();
        const failing = await packageOf(7, KEY, (p) =>
            replaceBytes(p.files[0], mainJsOf(`throw new Error("synthetic"); ${markerOf(7)}`))
        );
        device.vault.set("p.livesync-release", failing);

        const outcome = await device.coordinator.scan();

        expect(outcome?.status).toBe("restored");
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(releaseOf(device)).toBe(RUNNING_RELEASE);
        expect(device.host.instance).not.toBe(device.runningInstance);
        expect(device.records.hasFailedToLoad(await sha256HexOf(failing))).toBe(true);
        expect(device.notices).toEqual([expect.stringContaining("This package will not be tried again.")]);

        // The next start of the restored build finds the package again and leaves it alone.
        const operationsBefore = device.adapter.operations.length;
        await expect(new ReleaseInstallCoordinator(device.ports).scan()).resolves.toBeUndefined();
        expect(device.adapter.operations).toHaveLength(operationsBefore);
        expect(device.notices).toHaveLength(1);
    });
});

describe("a package whose files cannot be put in place", () => {
    it("releases the queue export pin when atomic replacement becomes unavailable before unload", async () => {
        const device = createDevice();
        const cancel = vi.fn();
        device.ports.install!.prepareForDowngrade = async () => {
            device.adapter.atomicReplace = undefined;
            return { isCurrent: () => true, cancel };
        };
        device.vault.set("p.livesync-release", await packageOf(7));

        expect(await device.coordinator.scan()).toEqual({
            status: "not-installed",
            reason: expect.stringContaining("atomically replace"),
        });
        expect(cancel).toHaveBeenCalledOnce();
        expect(device.host.instance).toBe(device.runningInstance);
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.adapter.operations).not.toContain("disablePlugin");
    });

    it("is not installed again and again by the restored build, which looks at the vault as soon as it loads", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        // main.js cannot be replaced: neither by a rename nor by a write of the new bytes.
        const newMainJs = encodeBase64(testFiles(7)["main.js"]);
        const locked = (path: string) => {
            if (path === pluginFile("main.js")) throw new Error("synthetic: locked");
        };
        device.adapter.intercept.rename = (_from, to) => locked(to);
        device.adapter.intercept.remove = locked;
        const write = device.adapter.writeBinary;
        device.adapter.writeBinary = async (path, data) => {
            if (encodeBase64(new Uint8Array(data)) === newMainJs) locked(path);
            await write(path, data);
        };

        const outcome = await device.coordinator.scan();

        expect(outcome).toEqual({ status: "restored", reason: "main.js could not be replaced" });
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(releaseOf(device)).toBe(RUNNING_RELEASE);
        const operationsBefore = device.adapter.operations.length;
        await expect(new ReleaseInstallCoordinator(device.ports).scan()).resolves.toBeUndefined();
        expect(device.adapter.operations).toHaveLength(operationsBefore);
        expect(device.notices).toHaveLength(1);
    });
});

describe("looks which overlap", () => {
    it("answers a request made during a look with one more look afterwards", async () => {
        const device = createDevice();
        const list = vi.spyOn(device.ports, "listPackageFiles");
        device.vault.set("p.livesync-release", await packageOf(4));

        const first = device.coordinator.scan();
        const second = device.coordinator.scan();
        await Promise.all([first, second]);

        expect(list).toHaveBeenCalledTimes(2);
    });

    it("does not start a second look while an install is pending, so one package installs once", async () => {
        const device = createDevice();
        device.vault.set("p.livesync-release", await packageOf(7));
        const list = vi.spyOn(device.ports, "listPackageFiles");
        // The plug-in is busy, so the install stages and then waits; a fresh scan arrives meanwhile.
        device.state.activity = { ...IDLE, remoteActivities: 1 };
        let looks = 0;
        device.state.onWait = (milliseconds) => {
            if (milliseconds !== device.ports.timings.idlePollMs) return;
            if (++looks === 1) void device.coordinator.scan();
            if (looks === 3) device.state.activity = { ...IDLE };
        };

        await expect(device.coordinator.scan()).resolves.toEqual({ status: "installed" });

        // The second scan, made while the install was pending, started no further look.
        expect(list).toHaveBeenCalledTimes(1);
        expect(device.adapter.operations.filter((operation) => operation === "disablePlugin")).toHaveLength(1);
    });
});

describe("device-local records", () => {
    it("remember a failed-to-load package for the session even when the store does not persist it", () => {
        // A store whose save is silently dropped, as the host's local storage can be.
        const records = createReleaseInstallRecords({ load: () => undefined, save: () => {} });

        expect(records.hasFailedToLoad("sha")).toBe(false);
        records.rememberFailedToLoad("sha");

        // Not kept by the store, but the running instance still never tries it again.
        expect(records.hasFailedToLoad("sha")).toBe(true);
    });

    it("do not treat a failed save which threw as success", () => {
        const records = createReleaseInstallRecords({
            load: () => undefined,
            save: () => {
                throw new Error("storage is full");
            },
        });

        expect(() => records.rememberFailedToLoad("sha")).not.toThrow();
        expect(records.hasFailedToLoad("sha")).toBe(true);
    });

    it("keep a bounded number of entries and survive unreadable storage", () => {
        let stored: unknown = "{not json";
        const records = createReleaseInstallRecords({ load: () => stored, save: (value) => void (stored = value) });
        expect(records.hasNoticed("a")).toBe(false);

        for (let index = 0; index <= MAX_RELEASE_INSTALL_RECORDS; index++) records.rememberNoticed(`n${index}`);
        records.rememberFailedToLoad("f");
        records.rememberFailedToLoad("f");

        expect(records.hasNoticed("n0")).toBe(false);
        expect(records.hasNoticed("n1")).toBe(true);
        expect(records.hasNoticed(`n${MAX_RELEASE_INSTALL_RECORDS}`)).toBe(true);
        expect(records.hasFailedToLoad("f")).toBe(true);
        expect(records.hasFailedToLoad("n1")).toBe(false);
        expect(JSON.parse(stored as string)).toEqual({
            noticed: expect.any(Array),
            failedToLoad: ["f"],
        });
    });

    it("never forgets a failed-to-load package, however many there are, so none is retried after a restart", () => {
        let stored: unknown;
        const storage = { load: () => stored, save: (value: string) => void (stored = value) };
        const writer = createReleaseInstallRecords(storage);
        const total = MAX_RELEASE_INSTALL_RECORDS * 2 + 5;
        for (let index = 0; index < total; index++) writer.rememberFailedToLoad(`fail-${index}`);

        // A later instance, as after a restart, reads only the store: its session memory is empty. Every failed hash
        // must still be known, or its still-failing package would be selected and reinstalled again, looping forever.
        const afterRestart = createReleaseInstallRecords(storage);
        for (let index = 0; index < total; index++) {
            expect(afterRestart.hasFailedToLoad(`fail-${index}`), `fail-${index} was forgotten`).toBe(true);
        }
        // The notice list, in contrast, stays bounded; only the failed-to-load list is kept in full.
        for (let index = 0; index <= MAX_RELEASE_INSTALL_RECORDS; index++) writer.rememberNoticed(`notice-${index}`);
        const rereadNotices = createReleaseInstallRecords(storage);
        expect(rereadNotices.hasNoticed("notice-0")).toBe(false);
        expect(rereadNotices.hasNoticed(`notice-${MAX_RELEASE_INSTALL_RECORDS}`)).toBe(true);
    });

    it("are shared by instances which read the same storage", () => {
        let stored: unknown;
        const storage = { load: () => stored, save: (value: string) => void (stored = value) };
        const earlier = createReleaseInstallRecords(storage);
        const later = createReleaseInstallRecords(storage);

        later.rememberNoticed("by-the-later-instance");
        earlier.rememberFailedToLoad("by-the-earlier-instance");

        expect(later.hasFailedToLoad("by-the-earlier-instance")).toBe(true);
        expect(earlier.hasNoticed("by-the-later-instance")).toBe(true);
    });
});
