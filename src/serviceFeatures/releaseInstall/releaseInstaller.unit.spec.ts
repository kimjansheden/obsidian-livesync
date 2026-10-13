import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    completeReleaseInstall,
    prepareReleaseInstall,
    trackLoadState,
    type PreparedReleaseInstall,
    type ReleaseInstallEnvironment,
    type ReleaseInstallTimings,
    type SecurityReleaseStatus,
} from "./releaseInstaller";
import { verifyReleasePackage, type VerifiedReleasePackage } from "./releasePackage";
import {
    buildUnsigned,
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
    sign,
    subtle,
    SyntheticPluginHost,
    TEST_PLUGIN_DIRECTORY,
    TEST_PLUGIN_ID,
    testFiles,
    verificationContext,
    type SyntheticInstance,
    type TestKey,
} from "./_releaseTestKit";

const RUNNING_RELEASE = 5;
const NEW_RELEASE = 7;
const PACKAGE_SHA256 = "a".repeat(64);
const FILE_NAMES = ["main.js", "manifest.json", "styles.css"] as const;
const TIMINGS: ReleaseInstallTimings = {
    readBackRetryDelaysMs: [1, 2, 3],
    teardownTimeoutMs: 50,
    loadTimeoutMs: 60,
    loadPollMs: 5,
};

let KEY: TestKey;
beforeAll(async () => {
    KEY = await generateTestKey();
});

/** A verified package of the synthetic release, optionally with another `main.js`. */
async function verifiedPackage(mainJs?: Uint8Array<ArrayBuffer>): Promise<VerifiedReleasePackage> {
    const unsigned = await buildUnsigned(NEW_RELEASE);
    if (mainJs) await replaceBytes(unsigned.files[0], mainJs);
    const verdict = await verifyReleasePackage(
        packageBytesOf(await sign(unsigned, KEY)),
        verificationContext(KEY, { runningReleaseNumber: RUNNING_RELEASE })
    );
    if (verdict.status !== "verified") throw new Error(`The synthetic package was not verified: ${verdict.status}`);
    return verdict.package;
}

function createDevice() {
    const adapter = new MemoryAdapter();
    installSyntheticBuild(adapter, RUNNING_RELEASE);
    const runningInstance = loadSyntheticBuild(adapter.files.get(pluginFile("main.js"))) as SyntheticInstance;
    const host = new SyntheticPluginHost(adapter, runningInstance);
    const notices: { message: string; lasting: boolean }[] = [];
    const failedToLoad: string[] = [];
    const waits: number[] = [];
    const env: ReleaseInstallEnvironment = {
        adapter,
        host,
        subtle,
        pluginId: TEST_PLUGIN_ID,
        pluginDirectory: TEST_PLUGIN_DIRECTORY,
        runningReleaseNumber: RUNNING_RELEASE,
        runningInstance,
        waitForTeardown: () => Promise.resolve(),
        records: { rememberFailedToLoad: (sha256) => void failedToLoad.push(sha256) },
        notify: (message, lasting) => void notices.push({ message, lasting }),
        wait: (milliseconds) => {
            waits.push(milliseconds);
            return new Promise((resolve) => setTimeout(resolve, milliseconds));
        },
        timings: TIMINGS,
    };
    const installedBefore = adapter.snapshot();
    /** The three files of the plug-in as they are now. */
    const pluginFiles = () =>
        Object.fromEntries(FILE_NAMES.map((name) => [name, encodeBase64(adapter.files.get(pluginFile(name))!)]));
    const filesBefore = pluginFiles();
    return {
        adapter,
        host,
        env,
        runningInstance,
        notices,
        failedToLoad,
        waits,
        installedBefore,
        pluginFiles,
        filesBefore,
    };
}

async function prepared(device: ReturnType<typeof createDevice>, mainJs?: Uint8Array<ArrayBuffer>) {
    const preparation = await prepareReleaseInstall(device.env, await verifiedPackage(mainJs), PACKAGE_SHA256);
    if (preparation.status !== "prepared") throw new Error(`Not prepared: ${preparation.reason}`);
    return preparation.install;
}

const packageFiles = () =>
    Object.fromEntries(Object.entries(testFiles(NEW_RELEASE)).map(([n, b]) => [n, encodeBase64(b)]));

describe("the load state which a build reports", () => {
    const status = (): SecurityReleaseStatus => ({ releaseNumber: NEW_RELEASE, loadState: "loading" });

    it("is loading until the plug-in has loaded, and loaded afterwards", async () => {
        const reported = status();
        let finish!: (loaded: boolean) => void;

        const loading = trackLoadState(reported, () => new Promise<boolean>((resolve) => (finish = resolve)));
        expect(reported.loadState).toBe("loading");
        finish(true);

        await expect(loading).resolves.toBe(true);
        expect(reported.loadState).toBe("loaded");
    });

    it("is failed when loading reports failure", async () => {
        const reported = status();

        await expect(trackLoadState(reported, async () => false)).resolves.toBe(false);

        expect(reported.loadState).toBe("failed");
    });

    it("is failed when loading throws, and the error is not swallowed", async () => {
        const reported = status();

        await expect(
            trackLoadState(reported, async () => {
                throw new Error("synthetic");
            })
        ).rejects.toThrow("synthetic");

        expect(reported.loadState).toBe("failed");
    });
});

describe("staging and backing up", () => {
    it("stages the package's files and backs the installed ones up, without changing what is installed", async () => {
        const device = createDevice();

        const install = await prepared(device);

        const files = testFiles(NEW_RELEASE);
        for (const name of FILE_NAMES) {
            expect(device.adapter.files.get(pluginFile(`${name}.incoming`))).toEqual(files[name]);
            expect(encodeBase64(device.adapter.files.get(pluginFile(`${name}.previous`))!)).toBe(
                device.filesBefore[name]
            );
        }
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.host.instance).toBe(device.runningInstance);
        expect(install.releaseNumber).toBe(NEW_RELEASE);
        expect(install.packageSha256).toBe(PACKAGE_SHA256);
        expect(device.adapter.operations).not.toContain("disablePlugin");
    });

    it("writes only the staged files and the backups", async () => {
        const device = createDevice();

        await prepared(device);

        expect(device.adapter.changedPaths()).toEqual(
            FILE_NAMES.flatMap((name) => [pluginFile(`${name}.incoming`), pluginFile(`${name}.previous`)]).sort()
        );
    });

    it("reads back what it wrote and writes again when the read-back is empty, as fresh files on some mobile storage are", async () => {
        const device = createDevice();
        let emptyReads = 2;
        device.adapter.intercept.read = (path, stored) =>
            path === pluginFile("main.js.incoming") && emptyReads-- > 0 ? new Uint8Array(0) : stored;

        await prepared(device);

        // Two reads came back empty, so the file was written three times, after the first two pauses.
        expect(device.adapter.operations.filter((op) => op === `write ${pluginFile("main.js.incoming")}`)).toHaveLength(
            3
        );
        expect(device.waits).toEqual([1, 2]);
        expect(device.pluginFiles()).toEqual(device.filesBefore);
    });

    it.each([
        ["empty", (stored: Uint8Array<ArrayBuffer>) => new Uint8Array(0)],
        ["short", (stored: Uint8Array<ArrayBuffer>) => stored.slice(0, stored.length - 1)],
        ["changed", (stored: Uint8Array<ArrayBuffer>) => stored.map((byte, index) => (index === 0 ? byte ^ 1 : byte))],
    ])(
        "gives up when a staged file keeps reading back %s, having changed nothing and left no staged file",
        async (_, falsify) => {
            const device = createDevice();
            device.adapter.intercept.read = (path, stored) =>
                path === pluginFile("manifest.json.incoming") ? (falsify(stored) as Uint8Array<ArrayBuffer>) : stored;

            const preparation = await prepareReleaseInstall(device.env, await verifiedPackage(), PACKAGE_SHA256);

            expect(preparation).toEqual({
                status: "failed",
                reason: "manifest.json could not be written and read back intact",
            });
            // Every pause was used before giving up.
            expect(device.waits).toEqual([...TIMINGS.readBackRetryDelaysMs]);
            expect(device.pluginFiles()).toEqual(device.filesBefore);
            expect([...device.adapter.files.keys()].filter((path) => path.endsWith(".incoming"))).toEqual([]);
            expect(device.adapter.operations).not.toContain("disablePlugin");
            expect(device.failedToLoad).toEqual([]);
        }
    );

    it("gives up when a staged file cannot be written, having changed nothing", async () => {
        const device = createDevice();
        device.adapter.intercept.write = (path) => {
            if (path.endsWith(".incoming")) throw new Error("synthetic: storage is full");
        };

        const preparation = await prepareReleaseInstall(device.env, await verifiedPackage(), PACKAGE_SHA256);

        expect(preparation.status).toBe("failed");
        expect(device.adapter.snapshot()).toEqual(device.installedBefore);
    });

    it("gives up when a backup does not read back as the installed file", async () => {
        const device = createDevice();
        device.adapter.intercept.read = (path, stored) =>
            path === pluginFile("main.js.previous") ? new Uint8Array(0) : stored;

        const preparation = await prepareReleaseInstall(device.env, await verifiedPackage(), PACKAGE_SHA256);

        expect(preparation).toEqual({
            status: "failed",
            reason: "the installed main.js could not be backed up and read back intact",
        });
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect([...device.adapter.files.keys()].filter((path) => path.endsWith(".incoming"))).toEqual([]);
    });

    it.each(["main.js", "manifest.json"] as const)(
        "refuses to back up an installed %s which reads as empty or cannot be read",
        async (name) => {
            const empty = createDevice();
            empty.adapter.intercept.read = (path, stored) => (path === pluginFile(name) ? new Uint8Array(0) : stored);
            const missing = createDevice();
            missing.adapter.files.delete(pluginFile(name));

            const emptyResult = await prepareReleaseInstall(empty.env, await verifiedPackage(), PACKAGE_SHA256);
            const missingResult = await prepareReleaseInstall(missing.env, await verifiedPackage(), PACKAGE_SHA256);

            expect(emptyResult).toEqual({ status: "failed", reason: `the installed ${name} reads as empty` });
            expect(missingResult.status).toBe("failed");
            expect(empty.adapter.files.has(pluginFile(`${name}.previous`))).toBe(false);
        }
    );
});

describe("swapping, reloading and verifying", () => {
    it.each(["refuse", "replace"] as const)(
        "installs the package where a rename onto an existing file would %s it",
        async (renameOntoExisting) => {
            const device = createDevice();
            device.adapter.renameOntoExisting = renameOntoExisting;
            const install = await prepared(device);

            const outcome = await completeReleaseInstall(device.env, install);

            expect(outcome).toEqual({ status: "installed" });
            expect(device.pluginFiles()).toEqual(packageFiles());
            const instance = device.host.instance as SyntheticInstance;
            expect(instance).not.toBe(device.runningInstance);
            expect(instance.securityRelease).toEqual({ releaseNumber: NEW_RELEASE, loadState: "loaded" });
            // The previous build stays beside the new one; nothing staged is left.
            for (const name of FILE_NAMES) {
                expect(encodeBase64(device.adapter.files.get(pluginFile(`${name}.previous`))!)).toBe(
                    device.filesBefore[name]
                );
                expect(device.adapter.files.has(pluginFile(`${name}.incoming`))).toBe(false);
            }
            expect(device.notices).toEqual([
                { message: expect.stringContaining("installed release 0.0.1-security.7"), lasting: false },
            ]);
            expect(device.failedToLoad).toEqual([]);
        }
    );

    it("never leaves main.js absent at any step of the swap on a mobile-style adapter", async () => {
        const device = createDevice();
        // The documented mobile path: a rename onto an existing file is refused, so the file is overwritten in place.
        device.adapter.renameOntoExisting = "refuse";
        const install = await prepared(device);
        const mainJs = pluginFile("main.js");

        // The state at the start of every mutating operation is a point the device could stop at. Record whether
        // main.js is present at each; it must never be missing, so no stop during the swap loses the only code file.
        const presentAtEachStep: boolean[] = [];
        const record = () => void presentAtEachStep.push(device.adapter.files.has(mainJs));
        device.adapter.intercept = { write: record, remove: record, rename: record };

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({ status: "installed" });
        expect(presentAtEachStep.length).toBeGreaterThan(0);
        expect(presentAtEachStep.every((present) => present)).toBe(true);
        expect(device.pluginFiles()).toEqual(packageFiles());
    });

    it("installs by writing directly where the adapter cannot rename at all", async () => {
        const device = createDevice();
        device.adapter.intercept.rename = () => {
            throw new Error("synthetic: rename is not supported");
        };

        const outcome = await completeReleaseInstall(device.env, await prepared(device));

        expect(outcome).toEqual({ status: "installed" });
        expect(device.pluginFiles()).toEqual(packageFiles());
        expect([...device.adapter.files.keys()].filter((path) => path.endsWith(".incoming"))).toEqual([]);
    });

    it("installs from the verified bytes when a staged file was changed while it waited", async () => {
        const device = createDevice();
        const install = await prepared(device);
        device.adapter.files.set(pluginFile("main.js.incoming"), mainJsOf(`tampered ${markerOf(NEW_RELEASE)}`));

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({ status: "installed" });
        expect(device.pluginFiles()).toEqual(packageFiles());
        // The changed file was never put in the place of main.js, not even for a moment.
        expect(device.adapter.operations).not.toContain(
            `rename ${pluginFile("main.js.incoming")} -> ${pluginFile("main.js")}`
        );
    });

    it("reads all three files back once the last of them is in place, and restores when one has changed", async () => {
        const device = createDevice();
        const install = await prepared(device);
        // manifest.json is replaced first; it is changed again while main.js, the last file, is put in place.
        device.adapter.intercept.rename = (_from, to) => {
            if (to === pluginFile("main.js")) device.adapter.files.set(pluginFile("manifest.json"), bytesOf("{}"));
        };

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({
            status: "restored",
            reason: "manifest.json does not read back as the package's file",
        });
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect((device.host.instance as SyntheticInstance).securityRelease.releaseNumber).toBe(RUNNING_RELEASE);
        // The restored build looks at the vault again at once, so the package must not be left to be tried again.
        expect(device.failedToLoad).toEqual([PACKAGE_SHA256]);
    });

    it("unloads before any installed file is touched, replaces main.js last, and loads afterwards", async () => {
        const device = createDevice();
        const install = await prepared(device);
        device.adapter.operations.length = 0;

        await completeReleaseInstall(device.env, install);

        const changes = device.adapter.operations.filter((operation) => !operation.startsWith("read "));
        const firstChangeOf = (name: string) =>
            changes.findIndex((operation) => operation.split(" ").includes(pluginFile(name)));
        expect(changes[0]).toBe("disablePlugin");
        expect(firstChangeOf("manifest.json")).toBeGreaterThan(0);
        expect(firstChangeOf("main.js")).toBeGreaterThan(firstChangeOf("manifest.json"));
        expect(firstChangeOf("main.js")).toBeGreaterThan(firstChangeOf("styles.css"));
        expect(changes.indexOf("loadManifests")).toBeGreaterThan(firstChangeOf("main.js"));
        expect(changes.indexOf("enablePlugin")).toBeGreaterThan(changes.indexOf("loadManifests"));
    });

    it("starts the unload before it returns, so nothing runs between the caller's last check and the unload", async () => {
        const device = createDevice();
        const install = await prepared(device);
        device.adapter.operations.length = 0;

        const completing = completeReleaseInstall(device.env, install);

        expect(device.adapter.operations).toEqual(["disablePlugin"]);
        await completing;
    });

    it("waits for the teardown of the unloaded instance before it replaces a file", async () => {
        const device = createDevice();
        const install = await prepared(device);
        let finishTeardown!: () => void;
        device.env.waitForTeardown = () => new Promise<void>((resolve) => (finishTeardown = resolve));
        device.env.timings = { ...TIMINGS, teardownTimeoutMs: 10_000 };

        const completing = completeReleaseInstall(device.env, install);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        finishTeardown();

        await expect(completing).resolves.toEqual({ status: "installed" });
    });

    it("goes on after the time limit when the teardown never settles", async () => {
        const device = createDevice();
        const install = await prepared(device);
        device.env.waitForTeardown = () => new Promise<void>(() => {});

        await expect(completeReleaseInstall(device.env, install)).resolves.toEqual({ status: "installed" });
    });

    it("writes nothing but the three files and their staged and backed-up companions", async () => {
        const device = createDevice();
        const vaultPackage = "inbox/0.0.1-security.7.livesync-release";
        device.adapter.files.set(vaultPackage, bytesOf("the package file"));

        await completeReleaseInstall(device.env, await prepared(device));

        const allowed = FILE_NAMES.flatMap((name) => ["", ".incoming", ".previous"].map((s) => pluginFile(name + s)));
        expect(device.adapter.changedPaths().filter((path) => !allowed.includes(path))).toEqual([
            "disablePlugin",
            "enablePlugin",
            "loadManifests",
        ]);
        expect(encodeBase64(device.adapter.files.get(pluginFile("data.json"))!)).toBe(
            device.installedBefore[pluginFile("data.json")]
        );
        expect(device.adapter.files.get(vaultPackage)).toEqual(bytesOf("the package file"));
    });

    it("replaces no file when the host does not unload the running build", async () => {
        const device = createDevice();
        const install = await prepared(device);
        device.host.disablePlugin = () => Promise.reject(new Error("synthetic: the host refused"));

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({ status: "not-installed", reason: "the host did not unload the running build" });
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.host.instance).toBe(device.runningInstance);
        expect([...device.adapter.files.keys()].filter((path) => path.endsWith(".incoming"))).toEqual([]);
        expect(device.notices).toEqual([{ message: expect.stringContaining("No file was replaced"), lasting: true }]);
        expect(device.failedToLoad).toEqual([]);
    });
});

describe("a new build which is not accepted", () => {
    /** Asserts that the device runs the previous build again, with byte for byte the files it had before. */
    function expectPreviousBuildRestored(device: ReturnType<typeof createDevice>) {
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        const instance = device.host.instance as SyntheticInstance;
        expect(instance).not.toBe(device.runningInstance);
        expect(instance.securityRelease).toEqual({ releaseNumber: RUNNING_RELEASE, loadState: "loaded" });
        expect([...device.adapter.files.keys()].filter((path) => path.endsWith(".incoming"))).toEqual([]);
        expect(encodeBase64(device.adapter.files.get(pluginFile("data.json"))!)).toBe(
            device.installedBefore[pluginFile("data.json")]
        );
    }

    it("puts the previous build back and runs it when the new main.js throws while it is loaded", async () => {
        const device = createDevice();
        const failing = mainJsOf(`throw new Error("synthetic"); ${markerOf(NEW_RELEASE)}`);

        const outcome = await completeReleaseInstall(device.env, await prepared(device, failing));

        expect(outcome).toEqual({ status: "restored", reason: "the new build did not load: the host did not load it" });
        expectPreviousBuildRestored(device);
        expect(device.failedToLoad).toEqual([PACKAGE_SHA256]);
        expect(device.notices).toEqual([
            {
                message: expect.stringMatching(
                    /was not installed: .* previous release was put back and is running\. This package will not be tried again\./u
                ),
                lasting: true,
            },
        ]);
    });

    it("remembers the package before it puts any file back", async () => {
        const device = createDevice();
        const install = await prepared(device, mainJsOf(`throw 1; ${markerOf(NEW_RELEASE)}`));
        const mainJsWrites = () =>
            device.adapter.operations.filter((op) => op === `write ${pluginFile("main.js")}`).length;
        const writesWhenRemembered: number[] = [];
        device.env.records = {
            rememberFailedToLoad: () => void writesWhenRemembered.push(mainJsWrites()),
        };

        await completeReleaseInstall(device.env, install);

        // The package is remembered once, before the previous main.js is written back: the restoring write is one
        // more than the writes which had happened when it was remembered (the mobile swap overwrites main.js once).
        expect(writesWhenRemembered).toHaveLength(1);
        expect(writesWhenRemembered[0]).toBeLessThan(mainJsWrites());
        expectPreviousBuildRestored(device);
    });

    it.each<[string, (device: ReturnType<typeof createDevice>) => void, string]>([
        [
            "never finishes loading",
            (device) => {
                const load = device.host.loadBuild;
                device.host.loadBuild = (mainJs) => {
                    const instance = load(mainJs) as SyntheticInstance;
                    if (instance.securityRelease.releaseNumber === NEW_RELEASE)
                        instance.securityRelease.loadState = "loading";
                    return instance;
                };
            },
            "it did not finish loading in time",
        ],
        [
            "ends loading without success",
            (device) => {
                const load = device.host.loadBuild;
                device.host.loadBuild = (mainJs) => {
                    const instance = load(mainJs) as SyntheticInstance;
                    if (instance.securityRelease.releaseNumber === NEW_RELEASE)
                        instance.securityRelease.loadState = "failed";
                    return instance;
                };
            },
            "it did not finish loading",
        ],
        [
            "reports another release number than the package",
            (device) => {
                const load = device.host.loadBuild;
                device.host.loadBuild = (mainJs) => {
                    const instance = load(mainJs) as SyntheticInstance;
                    if (instance.securityRelease.releaseNumber === NEW_RELEASE) {
                        instance.securityRelease = { releaseNumber: NEW_RELEASE + 1, loadState: "loaded" };
                    }
                    return instance;
                };
            },
            `it reports release ${NEW_RELEASE + 1} instead of ${NEW_RELEASE}`,
        ],
        [
            "does not report a release at all",
            (device) => {
                const load = device.host.loadBuild;
                device.host.loadBuild = (mainJs) => {
                    const instance = load(mainJs) as SyntheticInstance;
                    return instance.securityRelease.releaseNumber === NEW_RELEASE ? {} : instance;
                };
            },
            `it reports release undefined instead of ${NEW_RELEASE}`,
        ],
        [
            "makes the host fail while loading it",
            (device) => {
                const load = device.host.loadBuild;
                device.host.loadBuild = (mainJs) => {
                    const instance = load(mainJs) as SyntheticInstance;
                    if (instance.securityRelease.releaseNumber === NEW_RELEASE) throw new Error("synthetic");
                    return instance;
                };
            },
            "the host did not load it",
        ],
    ])("puts the previous build back when the new build %s", async (_, arrange, problem) => {
        const device = createDevice();
        const install = await prepared(device);
        arrange(device);

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({ status: "restored", reason: `the new build did not load: ${problem}` });
        expectPreviousBuildRestored(device);
        expect(device.failedToLoad).toEqual([PACKAGE_SHA256]);
    });

    it("does not take the instance which was running for a newly loaded build", async () => {
        const device = createDevice();
        const install = await prepared(device);
        // A host which hands the old instance back instead of loading the new files.
        Object.assign(device.runningInstance.securityRelease, { releaseNumber: NEW_RELEASE });
        device.host.loadBuild = (mainJs) =>
            loadSyntheticBuild(mainJs)?.securityRelease.releaseNumber === NEW_RELEASE
                ? device.runningInstance
                : loadSyntheticBuild(mainJs);
        device.env.runningReleaseNumber = RUNNING_RELEASE;

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome.status).toBe("restored");
        expect(device.pluginFiles()).toEqual(device.filesBefore);
    });

    it("puts the previous files back, and does not try the package again, when a file cannot be put in place", async () => {
        const device = createDevice();
        const install = await prepared(device);
        // main.js, the last of the three, cannot be replaced: neither by a rename nor by a write of the new bytes.
        const newMainJs = await sha256HexOf(testFiles(NEW_RELEASE)["main.js"]);
        let pendingWrite: Uint8Array<ArrayBuffer> | undefined;
        device.adapter.intercept.rename = (_from, to) => {
            if (to === pluginFile("main.js")) throw new Error("synthetic: locked");
        };
        device.adapter.intercept.remove = (path) => {
            if (path === pluginFile("main.js")) throw new Error("synthetic: locked");
        };
        const write = device.adapter.writeBinary;
        device.adapter.writeBinary = async (path, data) => {
            pendingWrite = new Uint8Array(data);
            if (path === pluginFile("main.js") && (await sha256HexOf(pendingWrite)) === newMainJs) {
                throw new Error("synthetic: locked");
            }
            await write(path, data);
        };

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome).toEqual({ status: "restored", reason: "main.js could not be replaced" });
        expectPreviousBuildRestored(device);
        // The restored build looks at the vault again at once, so the package must not be left to be tried again.
        expect(device.failedToLoad).toEqual([PACKAGE_SHA256]);
        expect(device.notices[0].message).toContain("This package will not be tried again.");
    });

    it("says plainly that manual reinstallation remains when the previous build cannot be loaded either", async () => {
        const device = createDevice();
        const install = await prepared(device, mainJsOf(`throw 1; ${markerOf(NEW_RELEASE)}`));
        device.host.loadBuild = () => undefined;

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome.status).toBe("restore-failed");
        // The files are back even though the host does not load them.
        expect(device.pluginFiles()).toEqual(device.filesBefore);
        expect(device.failedToLoad).toEqual([PACKAGE_SHA256]);
        expect(device.notices).toEqual([
            {
                message: expect.stringMatching(
                    /previous release could not be started again: .* is not running; reinstall it manually\./u
                ),
                lasting: true,
            },
        ]);
    });

    it("says so when the previous files cannot be put back", async () => {
        const device = createDevice();
        const install = await prepared(device, mainJsOf(`throw 1; ${markerOf(NEW_RELEASE)}`));
        const enable = vi.spyOn(device.host, "enablePlugin");
        let swapped = false;
        device.adapter.intercept.write = (path) => {
            if (swapped && path === pluginFile("main.js")) throw new Error("synthetic: storage failed");
        };
        const disable = device.host.disablePlugin;
        let unloads = 0;
        device.host.disablePlugin = (id) => {
            // The second unload is that of the rejected build; from then on main.js cannot be written.
            swapped = ++unloads > 1;
            return disable(id);
        };

        const outcome = await completeReleaseInstall(device.env, install);

        expect(outcome.status).toBe("restore-failed");
        expect(device.notices[0].message).toContain("its files could not be put back");
        // A build whose files are not all back is not started.
        expect(enable).toHaveBeenCalledOnce();
    });
});
