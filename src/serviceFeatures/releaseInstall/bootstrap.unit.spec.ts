import { buildSync } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    buildUnsigned,
    bytesOf,
    generateTestKey,
    packageBytesOf,
    sha256HexOf,
    sign,
    testFiles,
    verificationContext,
    type TestKey,
} from "./_releaseTestKit";
import { verifyReleasePackage } from "./releasePackage";
import { RELEASE_MARKER_PREFIX } from "./runningRelease";
afterEach(() => {
    vi.useRealTimers();
});
let key: TestKey;
beforeAll(async () => {
    key = await generateTestKey();
});
const id = "example-plugin";
const directory = `.obsidian/plugins/${id}`;
function source(release: number, behavior = "") {
    return bytesOf(`module.exports = class extends require("obsidian").Plugin {
        constructor(app, manifest) { super(app, manifest); this.core = { release: ${release} }; this.securityRelease = { bootstrapProtocol: 1, releaseNumber: ${release}, loadState: "loading", waitForStartup: () => this.startup ?? Promise.resolve(), waitForTeardown: async () => { events.push("teardown:${release}"); } }; }
        onload() { this.startup = this.start(); return this.startup; }
        async start() { events.push("load:${release}"); this.register(() => events.push("cleanup:${release}")); ${behavior} this.securityRelease.loadState = "loaded"; }
        onunload() { events.push("unload:${release}"); if (this._userDisabled) events.push("disabled:${release}"); }
        onUserEnable() { events.push("enable:${release}"); }
        async onExternalSettingsChange() { events.push("settings:${release}"); }
    }; // ${RELEASE_MARKER_PREFIX}${release}`);
}
async function fixture() {
    const files = testFiles(6);
    files["main.js"] = source(6);
    const unsigned = await buildUnsigned(6, files);
    const baseline = packageBytesOf({
        format: "livesync-bootstrap-baseline:1",
        pluginId: id,
        releaseNumber: 6,
        files: unsigned.files,
    });
    const sha256 = await sha256HexOf(baseline);
    const disk = new Map([
        [`${directory}/release-runtime/${sha256}.livesync-release`, baseline],
        [`${directory}/trusted-release-keys.json`, packageBytesOf({ format: 1, keys: [key.spkiBase64] })],
    ]);
    const events: string[] = [];
    const controls: Record<string, unknown> = {};
    const styles: { textContent?: string; dataset: Record<string, string>; remove(): void; removed: boolean }[] = [];
    class Plugin {
        _loaded = false;
        callbacks: (() => void)[] = [];
        settingTab: unknown = null;
        constructor(
            public app: unknown,
            public manifest: unknown
        ) {}
        async load() {
            if (!this._loaded) {
                this._loaded = true;
                await this.onload();
            }
        }
        async onload() {}
        unload() {
            if (this._loaded) {
                this._loaded = false;
                this.callbacks
                    .splice(0)
                    .reverse()
                    .forEach((fn) => fn());
                this.onunload();
            }
        }
        onunload() {}
        register(fn: () => void) {
            this.callbacks.push(fn);
        }
        async loadCSS() {
            throw new Error("root CSS must never be loaded");
        }
        onUserEnable() {}
    }
    const app = {
        vault: {
            configDir: ".obsidian",
            adapter: {
                readBinary: async (path: string) => {
                    const value = disk.get(path);
                    if (!value) throw new Error("missing");
                    return value.slice().buffer;
                },
                writeBinary: async (path: string, value: ArrayBuffer) => {
                    disk.set(path, new Uint8Array(value));
                },
                exists: async (path: string) => path === `${directory}/release-runtime/` || disk.has(path),
                list: async () => ({ files: [...disk.keys()] }),
                mkdir: async () => undefined,
            },
        },
    };
    const commonJs: { exports: { default?: typeof Plugin } } = { exports: {} };
    const document = {
        createElement: () => {
            const style = {
                dataset: {},
                textContent: "",
                removed: false,
                remove() {
                    this.removed = true;
                },
            };
            return style;
        },
        head: {
            appendChild: (style: (typeof styles)[number]) => {
                styles.push(style);
            },
        },
    };
    const window = { crypto, setTimeout, clearTimeout, eval: (value: string): unknown => runInContext(value, context) };
    const context = createContext({
        window,
        document,
        crypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        Map,
        Set,
        console,
        events,
        controls,
        AbortController,
        module: commonJs,
        exports: commonJs.exports,
        require: (name: string) => {
            if (name !== "obsidian") throw new Error("unexpected require");
            return { Plugin, Notice: class {} };
        },
    });
    const bundle = buildSync({
        entryPoints: ["src/serviceFeatures/releaseInstall/bootstrap.ts"],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "browser",
        external: ["obsidian"],
        define: {
            LIVESYNC_BOOTSTRAP_BASELINE_SHA256: JSON.stringify(sha256),
            SECURITY_RELEASE_MARKER: JSON.stringify(`${RELEASE_MARKER_PREFIX}6`),
        },
    });
    runInContext(bundle.outputFiles[0].text, context);
    const Constructor = commonJs.exports.default!;
    const create = () =>
        new Constructor(app, { id, version: "0.0.1", dir: directory }) as InstanceType<typeof Plugin> & {
            core: { release: number };
            releaseRuntimeInstance: {
                securityRelease: {
                    bootstrapRuntime: {
                        stage: (value: unknown, sha: string) => Promise<void>;
                        activate: (sha: string) => Promise<void>;
                    };
                };
            };
            onExternalSettingsChange(): Promise<void>;
        };
    const candidate = async (behavior = "", transform: (source: string) => string = (value) => value) => {
        const files = testFiles(7);
        files["main.js"] = bytesOf(transform(new TextDecoder().decode(source(7, behavior))));
        const bytes = packageBytesOf(await sign(await buildUnsigned(7, files), key));
        const verdict = await verifyReleasePackage(bytes, verificationContext(key));
        if (verdict.status !== "verified") throw new Error("fixture signature");
        return { verified: verdict.package, sha256: await sha256HexOf(bytes) };
    };
    return { create, candidate, disk, styles, events, baseline, controls };
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function activateFixture(behavior: string) {
    const f = await fixture();
    const first = f.create();
    await first.load();
    const candidate = await f.candidate(behavior);
    const port = first.releaseRuntimeInstance.securityRelease.bootstrapRuntime;
    await port.stage(candidate.verified, candidate.sha256);
    first.unload();
    await port.activate(candidate.sha256);
    return f;
}
describe("the real compiled CommonJS bootstrap boundary", () => {
    it("uses the captured Obsidian require, awaits a real child, forwards host hooks and removes CSS/events", async () => {
        const f = await fixture();
        const plugin = f.create();
        await plugin.load();
        await plugin.loadCSS();
        expect(plugin.core.release).toBe(6);
        expect(plugin.releaseRuntimeInstance).toBeDefined();
        plugin.onUserEnable();
        await plugin.onExternalSettingsChange();
        plugin.unload();
        expect(f.events).toEqual(["load:6", "enable:6", "settings:6", "cleanup:6", "unload:6"]);
        expect(f.styles).toHaveLength(1);
        expect(f.styles[0].removed).toBe(true);
    });
    it("drains callbacks from startup which finishes after facade unload", async () => {
        const f = await activateFixture('await controls.startup; this.register(() => events.push("late-cleanup:7"));');
        const startup = deferred();
        f.controls.startup = startup.promise;
        const plugin = f.create();
        const outcome = plugin.load().catch((error) => error);
        await vi.waitFor(() => expect(f.events).toContain("load:7"));
        plugin.unload();
        startup.resolve();
        await outcome;
        await vi.waitFor(() => expect(f.events).toContain("late-cleanup:7"));
        expect(f.events.filter((event) => event === "unload:7")).toHaveLength(2);
        expect(plugin.releaseRuntimeInstance).toBeUndefined();
        expect(f.styles.filter((style) => !style.removed)).toHaveLength(0);
    });
    it("cleans rejected code independently of its throwing downgrade export", async () => {
        const f = await activateFixture(
            'this.securityRelease.prepareForDowngrade = async () => { events.push("export:7"); throw new Error("export failed"); }; throw new Error("load failed");'
        );
        const plugin = f.create();
        await plugin.load();
        expect(plugin.core.release).toBe(6);
        expect(f.events).not.toContain("export:7");
        expect(f.events).toContain("cleanup:7");
        expect(f.events).toContain("unload:7");
    });
    it("blocks fallback while rejected code has unresolved teardown", async () => {
        vi.useFakeTimers();
        const f = await activateFixture(
            'this.securityRelease.waitForTeardown = () => controls.teardown; throw new Error("load failed");'
        );
        const teardown = deferred();
        f.controls.teardown = teardown.promise;
        const plugin = f.create();
        const outcome = plugin.load().catch((error) => error);
        await vi.waitFor(() => expect(f.events).toContain("unload:7"));
        await vi.advanceTimersByTimeAsync(30_001);
        expect(await outcome).toMatchObject({ message: expect.stringContaining("Neither") });
        expect(f.events.filter((event) => event === "load:6")).toHaveLength(1);
        expect(plugin.core.release).toBe(7);
        teardown.resolve();
        await vi.runAllTimersAsync();
        expect(f.events.filter((event) => event === "load:6")).toHaveLength(1);
    });
    it("blocks fallback when a rejected candidate cleanup callback throws before onUnload", async () => {
        const f = await activateFixture(
            'this.register(() => { events.push("cleanup-throw:7"); throw new Error("cleanup failure"); }); throw new Error("load failed");'
        );
        const plugin = f.create();
        await expect(plugin.load()).rejects.toThrow("Neither");
        expect(f.events).toContain("cleanup-throw:7");
        expect(f.events.filter((event) => event === "load:6")).toHaveLength(1);
        expect(plugin.core.release).toBe(7);
        expect(f.events).not.toContain("unload:7");
    });
    it.each(["waitForStartup", "waitForTeardown"])(
        "rejects a signed protocol1 payload missing %s before calling onload",
        async (hook) => {
            const f = await fixture();
            const first = f.create();
            await first.load();
            const candidate = await f.candidate('events.push("unsafe-late-startup");', (value) =>
                value.replace(
                    hook === "waitForStartup"
                        ? "waitForStartup: () => this.startup ?? Promise.resolve(), "
                        : 'waitForTeardown: async () => { events.push("teardown:7"); }',
                    hook === "waitForStartup" ? "" : "removedTeardown: true"
                )
            );
            const port = first.releaseRuntimeInstance.securityRelease.bootstrapRuntime;
            await port.stage(candidate.verified, candidate.sha256);
            first.unload();
            await port.activate(candidate.sha256);
            const plugin = f.create();
            await plugin.load();
            expect(plugin.core.release).toBe(6);
            expect(f.events).not.toContain("load:7");
            expect(f.events).not.toContain("unsafe-late-startup");
        }
    );
    it("owns startup even when the host child load method returns void", async () => {
        const f = await fixture();
        const first = f.create();
        await first.load();
        const candidate = await f.candidate(
            'await controls.startup; this.register(() => events.push("late-cleanup:7"));',
            (value) =>
                value.replace(
                    "onload() { this.startup = this.start();",
                    "load() { this._loaded = true; void this.onload(); } onload() { this.startup = this.start();"
                )
        );
        const port = first.releaseRuntimeInstance.securityRelease.bootstrapRuntime;
        await port.stage(candidate.verified, candidate.sha256);
        first.unload();
        await port.activate(candidate.sha256);
        const startup = deferred();
        f.controls.startup = startup.promise;
        const plugin = f.create();
        const outcome = plugin.load().catch((error) => error);
        await vi.waitFor(() => expect(f.events).toContain("load:7"));
        plugin.unload();
        startup.resolve();
        await outcome;
        await vi.waitFor(() => expect(f.events).toContain("late-cleanup:7"));
        expect(f.events.filter((event) => event === "unload:7")).toHaveLength(2);
        expect(plugin.releaseRuntimeInstance).toBeUndefined();
    });
    it("keeps late startup cleanup alive after the recovery deadline without starting fallback", async () => {
        vi.useFakeTimers();
        const f = await activateFixture('await controls.startup; this.register(() => events.push("late-cleanup:7"));');
        const startup = deferred();
        f.controls.startup = startup.promise;
        const plugin = f.create();
        const outcome = plugin.load().catch((error) => error);
        await vi.waitFor(() => expect(f.events).toContain("load:7"));
        await vi.advanceTimersByTimeAsync(90_001);
        expect(await outcome).toMatchObject({ message: expect.stringContaining("Neither") });
        expect(f.events.filter((event) => event === "load:6")).toHaveLength(1);
        startup.resolve();
        await vi.waitFor(() => expect(f.events).toContain("late-cleanup:7"));
        expect(f.events.filter((event) => event === "load:6")).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("aborts the void-load status poll on timeout and leaves no timer after fallback", async () => {
        vi.useFakeTimers();
        const f = await activateFixture('this.securityRelease.loadState = "loading"; return;');
        const plugin = f.create();
        const loading = plugin.load();
        await vi.waitFor(() => expect(f.events).toContain("load:7"));
        await vi.advanceTimersByTimeAsync(60_001);
        await loading;
        expect(plugin.core.release).toBe(6);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("forwards the host user-disabled flag so child registered views can detach", async () => {
        const f = await fixture();
        const plugin = f.create();
        await plugin.load();
        Reflect.set(plugin, "_userDisabled", true);
        plugin.unload();
        expect(f.events).toContain("disabled:6");
    });
    it("loads a signed payload after reload without replacing root code, then keeps running after restart", async () => {
        const f = await fixture();
        const first = f.create();
        await first.load();
        const candidate = await f.candidate();
        const port = first.releaseRuntimeInstance.securityRelease.bootstrapRuntime;
        await port.stage(candidate.verified, candidate.sha256);
        first.unload();
        await port.activate(candidate.sha256);
        const second = f.create();
        await second.load();
        expect(second.core.release).toBe(7);
        expect(f.styles[0].removed).toBe(true);
        expect(f.styles[1].removed).toBe(false);
        second.unload();
        const third = f.create();
        await third.load();
        expect(third.core.release).toBe(7);
        expect(
            [...f.disk.keys()].every(
                (path) => path.includes("/release-runtime/") || path.endsWith("trusted-release-keys.json")
            )
        ).toBe(true);
    });
    it("cleans a child whose async onload throws and restores baseline with its own CSS", async () => {
        const f = await fixture();
        const first = f.create();
        await first.load();
        const candidate = await f.candidate('throw new Error("candidate failed");');
        const port = first.releaseRuntimeInstance.securityRelease.bootstrapRuntime;
        await port.stage(candidate.verified, candidate.sha256);
        first.unload();
        await port.activate(candidate.sha256);
        const next = f.create();
        await next.load();
        expect(next.core.release).toBe(6);
        expect(f.events).toContain("cleanup:7");
        expect(f.events).toContain("unload:7");
        expect(f.events).toContain("teardown:7");
        expect(f.styles.filter((style) => !style.removed)).toHaveLength(1);
        next.unload();
        const restart = f.create();
        await restart.load();
        expect(restart.core.release).toBe(6);
        expect(f.events.filter((event) => event === "load:7")).toHaveLength(1);
    });
});
