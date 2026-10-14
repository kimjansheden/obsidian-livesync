/** Permanent Obsidian entry point. Its executable is installed locally once and never updated through the vault. */
import { Platform, Plugin, Notice, requireApiVersion, type PluginManifest } from "obsidian";
import { RELEASE_MARKER_PREFIX } from "./runningRelease";
import { decodeStrictUtf8 } from "./releaseBytes";
import { ReleaseRuntime, type BootstrapRuntimePort } from "./releaseRuntime";
import { parseTrustedReleaseKeys, TRUSTED_RELEASE_KEYS_FILE } from "./trustedReleaseKeys";
import type { VerifiedReleasePackage } from "./releasePackage";
import type { SecurityReleaseStatus } from "./releaseInstaller";

declare const LIVESYNC_BOOTSTRAP_BASELINE_SHA256: string;
// Obsidian supplies this CommonJS require, including the exact Plugin class used by its instanceof check.
const hostRequire: (name: string) => unknown = require;
interface PayloadPlugin extends Plugin {
    securityRelease: SecurityReleaseStatus & {
        bootstrapProtocol: 1;
        waitForStartup(): Promise<unknown>;
        waitForTeardown(): Promise<unknown>;
    };
    core?: unknown;
    onExternalSettingsChange?: () => Promise<void>;
}
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
/** A cancelled status wait removes its timer immediately, rather than leaving a polling task alive. */
function pollPause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("The runtime startup was cancelled"));
            return;
        }
        const abort = () => {
            window.clearTimeout(timer);
            reject(new Error("The runtime startup was cancelled"));
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}
const LOAD_TIMEOUT_MS = 60_000;
function assertManifestCompatibility(manifest: PluginManifest): void {
    if (typeof manifest.minAppVersion === "string" && !requireApiVersion(manifest.minAppVersion)) {
        throw new Error(`The runtime requires Obsidian ${manifest.minAppVersion} or later`);
    }
    if (manifest.isDesktopOnly === true && !Platform.isDesktopApp) {
        throw new Error("The runtime is available only in the Obsidian desktop app");
    }
}
async function bounded<T>(work: Promise<T>, limit: number): Promise<T> {
    let timer: number | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = window.setTimeout(() => reject(new Error("The runtime lifecycle timed out")), limit);
            }),
        ]);
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
    }
}

export default class LiveSyncBootstrap extends Plugin {
    private runtime: ReleaseRuntime | undefined;
    private payload: PayloadPlugin | undefined;
    private style: HTMLStyleElement | undefined;
    private stopped = false;
    private published = false;
    private generation = 0;
    private payloadStartup: Promise<void> | undefined;
    private startupSettled = true;
    private startupAbort: AbortController | undefined;
    private payloadStopping: Promise<void> | undefined;
    private recoveryBlocked = false;
    /** Explicit host boundary; the installer compares real payload identities, not the facade. */
    get releaseRuntimeInstance(): PayloadPlugin | undefined {
        return this.published ? this.payload : undefined;
    }
    get core(): unknown {
        return this.payload?.core;
    }
    get securityRelease(): SecurityReleaseStatus | undefined {
        return this.payload?.securityRelease;
    }

    override async onload(): Promise<void> {
        const pluginDirectory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        this.stopped = false;
        this.runtime = new ReleaseRuntime({
            adapter: this.app.vault.adapter,
            pluginDirectory,
            baselineSha256: LIVESYNC_BOOTSTRAP_BASELINE_SHA256,
            verification: async () => {
                let trustedKeys: Awaited<ReturnType<typeof parseTrustedReleaseKeys>> = {
                    status: "invalid",
                    reason: "missing",
                };
                try {
                    trustedKeys = await parseTrustedReleaseKeys(
                        new Uint8Array(
                            await this.app.vault.adapter.readBinary(`${pluginDirectory}/${TRUSTED_RELEASE_KEYS_FILE}`)
                        ),
                        window.crypto.subtle
                    );
                } catch {
                    /* Without keys only an already locally authenticated payload can run. */
                }
                return {
                    pluginId: this.manifest.id,
                    runningReleaseNumber: 0,
                    markerPrefix: RELEASE_MARKER_PREFIX,
                    trustedKeys: trustedKeys.status === "valid" ? trustedKeys.keys : [],
                    subtle: window.crypto.subtle,
                };
            },
            wait: pause,
            retryDelaysMs: [200, 200, 200, 3_000, 15_000, 60_000],
            load: (verified, port) => this.loadPayload(verified, port, pluginDirectory),
            notify: (message) => {
                new Notice(message, 0);
            },
        });
        await this.runtime.start();
        if (this.stopped) throw new Error("The bootstrap unloaded during startup");
        this.published = true;
    }
    /** Keep ownership until startup and every teardown have actually settled. Timeout blocks recovery. */
    private async stopPayload(): Promise<void> {
        if (this.recoveryBlocked) throw new Error("Runtime cleanup did not settle; restart Obsidian before recovery");
        if (this.payloadStopping) return await this.payloadStopping;
        const child = this.payload;
        if (!child) return;
        const loading = !this.startupSettled;
        this.startupAbort?.abort();
        this.generation++;
        Reflect.set(child, "_userDisabled", Reflect.get(this, "_userDisabled"));
        this.recoveryBlocked = true;
        child.unload();
        this.recoveryBlocked = false;
        this.style?.remove();
        this.style = undefined;
        // The cleanup task itself is never abandoned by its observer's deadline. If startup resumes late,
        // it still drains its newly registered effects; the deadline only prevents starting another payload.
        this.payloadStopping = (async () => {
            if (this.payloadStartup)
                await this.payloadStartup.then(
                    () => undefined,
                    () => undefined
                );
            let teardownFailure: unknown;
            let teardownFailed = false;
            try {
                await child.securityRelease.waitForTeardown?.();
            } catch (error) {
                teardownFailure = error;
                teardownFailed = true;
            }
            if (loading) {
                // Component.unload ignores an already unloaded child. After its late onload has settled,
                // re-arm only the unload flag (never onload) to drain callbacks/children registered meanwhile.
                Reflect.set(child, "_loaded", true);
                child.unload();
                try {
                    await child.securityRelease.waitForTeardown?.();
                } catch (error) {
                    teardownFailure = error;
                    teardownFailed = true;
                }
            }
            if (teardownFailed) throw teardownFailure;
            this.payload = undefined;
            this.payloadStartup = undefined;
        })();
        try {
            await bounded(this.payloadStopping, 30_000);
        } catch (error) {
            this.recoveryBlocked = true;
            throw error;
        } finally {
            if (!this.recoveryBlocked) this.payloadStopping = undefined;
        }
    }
    private async loadPayload(
        verified: VerifiedReleasePackage,
        port: BootstrapRuntimePort,
        pluginDirectory: string
    ): Promise<void> {
        await this.stopPayload();
        const generation = ++this.generation;
        if (this.stopped) throw new Error("The bootstrap has unloaded");
        const files = new Map(verified.files.map((file) => [file.name, file]));
        const parsedManifest: unknown = JSON.parse(decodeStrictUtf8(files.get("manifest.json")!.bytes));
        const manifest = { ...(parsedManifest as PluginManifest), dir: pluginDirectory };
        assertManifestCompatibility(manifest);
        const source = decodeStrictUtf8(files.get("main.js")!.bytes);
        const commonJs = { exports: {} as unknown };
        // Only hash-authenticated baseline/accepted bytes or newly signature-verified bytes reach this boundary.
        const factory: unknown = window.eval(
            `(function(require,module,exports){${source}\n})\n//# sourceURL=plugin:obsidian-livesync-runtime-${port.payloadSha256}`
        );
        if (typeof factory !== "function") throw new Error("The runtime module did not compile");
        Reflect.apply(factory, undefined, [hostRequire, commonJs, commonJs.exports]);
        const exported = commonJs.exports;
        const constructor: unknown =
            (typeof exported === "object" && exported !== null && Reflect.get(exported, "default")) || exported;
        if (typeof constructor !== "function") throw new Error("The runtime exports no Plugin constructor");
        const child: unknown = Reflect.construct(constructor, [this.app, manifest]);
        if (!(child instanceof Plugin)) throw new Error("The runtime is not an Obsidian Plugin");
        const payload = child as PayloadPlugin;
        if (
            payload.securityRelease?.bootstrapProtocol !== 1 ||
            payload.securityRelease.releaseNumber !== verified.releaseNumber ||
            typeof payload.securityRelease.waitForStartup !== "function" ||
            typeof payload.securityRelease.waitForTeardown !== "function"
        )
            throw new Error("The runtime does not implement bootstrap protocol 1");
        payload.securityRelease.bootstrapRuntime = port;
        this.payload = payload;
        this.startupAbort = new AbortController();
        const signal = this.startupAbort.signal;
        this.startupSettled = false;
        this.payloadStartup = Promise.resolve()
            .then(() => payload.load())
            .then(async () => {
                await payload.securityRelease.waitForStartup();
            });
        void this.payloadStartup.then(
            () => {
                this.startupSettled = true;
            },
            () => {
                this.startupSettled = true;
            }
        );
        try {
            await bounded(
                (async () => {
                    await this.payloadStartup;
                    while (payload.securityRelease.loadState === "loading") {
                        if (signal.aborted || this.stopped || generation !== this.generation)
                            throw new Error("The runtime startup was cancelled");
                        await pollPause(50, signal);
                    }
                    if (payload.securityRelease.loadState !== "loaded")
                        throw new Error("The runtime did not finish loading");
                })(),
                LOAD_TIMEOUT_MS
            );
            if (this.stopped || generation !== this.generation) throw new Error("The runtime startup was cancelled");
            const style = document.createElement("style");
            style.dataset.livesyncRuntime = port.payloadSha256;
            style.textContent = decodeStrictUtf8(files.get("styles.css")!.bytes);
            document.head.appendChild(style);
            this.style = style;
            this.manifest = manifest;
            Reflect.set(this, "settingTab", Reflect.get(payload, "settingTab"));
        } catch (error) {
            this.startupAbort?.abort();
            await this.stopPayload();
            throw error;
        }
    }
    /** The root CSS belongs to the loader; the selected payload's verified CSS was already installed above. */
    loadCSS(): Promise<void> {
        return Promise.resolve();
    }
    override onUserEnable(): void {
        this.payload?.onUserEnable();
    }
    override async onExternalSettingsChange(): Promise<void> {
        await this.payload?.onExternalSettingsChange?.();
        Reflect.set(this, "settingTab", this.payload ? Reflect.get(this.payload, "settingTab") : null);
    }
    override onunload(): void {
        this.published = false;
        this.stopped = true;
        this.generation++;
        this.runtime?.cancel();
        // Protocol 1 payloads share the same durable queue format. Recovery never depends on rejected code
        // exporting that queue. Cleanup starts synchronously and retains ownership through late startup.
        void this.stopPayload().catch((error: unknown) => {
            new Notice(`LiveSync runtime cleanup could not finish: ${String(error)}`, 0);
        });
    }
}
