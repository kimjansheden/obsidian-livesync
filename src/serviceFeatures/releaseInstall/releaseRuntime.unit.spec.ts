import { beforeAll, describe, expect, it, vi } from "vitest";
import {
    ReleaseRuntime,
    type BootstrapRuntimePort,
    type ReleaseRuntimeEnvironment,
    readBootstrapBaseline,
} from "./releaseRuntime";
import { verifyReleasePackage, readPinnedReleasePackage } from "./releasePackage";
import { createOwnPluginProtectedPathMatcher, createOwnPluginRemovalProtectedPathMatcher } from "./trustedReleaseKeys";
import {
    buildUnsigned,
    bytesOf,
    generateTestKey,
    packageBytesOf,
    sha256HexOf,
    signedAfter,
    verificationContext,
    TEST_PLUGIN_ID,
    type TestKey,
} from "./_releaseTestKit";
let key: TestKey;
beforeAll(async () => {
    key = await generateTestKey();
});
const directory = ".obsidian/plugins/example-plugin";
const runtimePath = (name: string) => `${directory}/release-runtime/${name}`;
async function fixture() {
    const unsigned = await buildUnsigned(6);
    const baseline = packageBytesOf({
        format: "livesync-bootstrap-baseline:1",
        pluginId: TEST_PLUGIN_ID,
        releaseNumber: 6,
        files: unsigned.files,
    });
    const baselineSha256 = await sha256HexOf(baseline);
    const files = new Map<string, Uint8Array<ArrayBuffer>>([
        [runtimePath(`${baselineSha256}.livesync-release`), baseline],
    ]);
    const writes: string[] = [];
    const loaded: number[] = [];
    const ports: BootstrapRuntimePort[] = [];
    let trustedKeys = [key.trusted];
    let rejectRelease: number | undefined;
    let onWrite: ((path: string) => void) | undefined;
    const env: ReleaseRuntimeEnvironment = {
        adapter: {
            readBinary: async (path) => {
                const bytes = files.get(path);
                if (!bytes) throw new Error("missing");
                return bytes.slice().buffer;
            },
            writeBinary: async (path, value) => {
                files.set(path, new Uint8Array(value));
                writes.push(path);
                onWrite?.(path);
            },
            list: async (path) => ({ files: [...files.keys()].filter((key) => key.startsWith(path)) }),
            exists: async (path) => path === runtimePath("") || files.has(path),
            mkdir: async () => undefined,
        },
        pluginDirectory: directory,
        baselineSha256,
        verification: async () => verificationContext(key, { trustedKeys, runningReleaseNumber: 0 }),
        wait: async () => undefined,
        retryDelaysMs: [],
        load: async (verified, port) => {
            loaded.push(verified.releaseNumber);
            ports.push(port);
            if (verified.releaseNumber === rejectRelease) throw new Error("synthetic load failure");
        },
        notify: vi.fn(),
    };
    const candidate = packageBytesOf(await signedAfter(key));
    const candidateSha256 = await sha256HexOf(candidate);
    const verdict = await verifyReleasePackage(candidate, await env.verification());
    if (verdict.status !== "verified") throw new Error("fixture signature");
    return {
        env,
        files,
        writes,
        loaded,
        ports,
        baseline,
        baselineSha256,
        candidate,
        candidateSha256,
        verified: verdict.package,
        runtime: () => new ReleaseRuntime(env),
        noKeys: () => {
            trustedKeys = [];
        },
        reject: (release: number) => {
            rejectRelease = release;
        },
        onWrite: (callback: (path: string) => void) => {
            onWrite = callback;
        },
    };
}
async function staged(f: Awaited<ReturnType<typeof fixture>>) {
    await f.runtime().start();
    const port = f.ports[f.ports.length - 1]!;
    await port.stage(f.verified, f.candidateSha256);
    return port;
}
describe("permanent bootstrap storage and recovery", () => {
    it("starts the hash-pinned baseline without trusting any sync key", async () => {
        const f = await fixture();
        f.noKeys();
        await f.runtime().start();
        expect(f.loaded).toEqual([6]);
        expect(f.writes).toEqual([]);
        expect(f.ports[0].payloadSha256).toBe(
            await sha256HexOf(
                (await readBootstrapBaseline(f.baseline, await f.env.verification(), f.baselineSha256)).files[0].bytes
            )
        );
    });
    it("repeated staging and activation reuse identical immutable bytes", async () => {
        const f = await fixture();
        const port = await staged(f);
        await port.stage(f.verified, f.candidateSha256);
        await port.activate(f.candidateSha256);
        await port.activate(f.candidateSha256);
        expect(f.writes.filter((path) => path.endsWith(`${f.candidateSha256}.livesync-release`))).toHaveLength(1);
        expect(f.writes.filter((path) => path.endsWith(`intent-${f.candidateSha256}.json`))).toHaveLength(1);
    });
    it("refuses to replace a complete activation record which names another previous build", async () => {
        const f = await fixture();
        const port = await staged(f);
        const path = runtimePath(`intent-${f.candidateSha256}.json`);
        const existing = packageBytesOf({
            protocol: 1,
            packageSha256: f.candidateSha256,
            previousSha256: "0".repeat(64),
        });
        f.files.set(path, existing);
        await expect(port.activate(f.candidateSha256)).rejects.toThrow("another previous build");
        expect(f.files.get(path)).toEqual(existing);
    });
    it("a staged package is never selected without an intent", async () => {
        const f = await fixture();
        await staged(f);
        await f.runtime().start();
        expect(f.loaded).toEqual([6, 6]);
    });
    it("activates a signed newer package, preserves baseline bytes and records acceptance", async () => {
        const f = await fixture();
        const baselineBefore = f.baseline.slice();
        const port = await staged(f);
        await port.activate(f.candidateSha256);
        await f.runtime().start();
        expect(f.loaded).toEqual([6, 7]);
        expect(f.files.get(runtimePath(`${f.baselineSha256}.livesync-release`))).toEqual(baselineBefore);
        expect(f.files.has(runtimePath(`accepted-${f.candidateSha256}.json`))).toBe(true);
        expect(f.writes.every((path) => path.startsWith(runtimePath("")))).toBe(true);
        f.noKeys();
        await f.runtime().start();
        expect(f.loaded[f.loaded.length - 1]).toBe(7);
    });
    it("activation survives unloading the old bootstrap closure", async () => {
        const f = await fixture();
        const runtime = f.runtime();
        await runtime.start();
        const port = f.ports[0];
        await port.stage(f.verified, f.candidateSha256);
        runtime.cancel();
        await port.activate(f.candidateSha256);
        await f.runtime().start();
        expect(f.loaded).toEqual([6, 7]);
    });
    it("a failed child falls back and is never attempted again across startup", async () => {
        const f = await fixture();
        const port = await staged(f);
        await port.activate(f.candidateSha256);
        f.reject(7);
        await f.runtime().start();
        await f.runtime().start();
        expect(f.loaded).toEqual([6, 7, 6, 6]);
    });
    it.each(["package", "intent", "attempt", "accepted"])(
        "a torn %s file leaves a complete runnable baseline",
        async (kind) => {
            const f = await fixture();
            const port = await staged(f);
            await port.activate(f.candidateSha256);
            if (kind === "attempt" || kind === "accepted")
                f.files.set(
                    runtimePath(`attempt-${f.candidateSha256}.json`),
                    packageBytesOf({ protocol: 1, packageSha256: f.candidateSha256, previousSha256: f.baselineSha256 })
                );
            const path =
                kind === "package"
                    ? runtimePath(`${f.candidateSha256}.livesync-release`)
                    : runtimePath(`${kind}-${f.candidateSha256}.json`);
            f.files.set(path, bytesOf("{"));
            await f.runtime().start();
            // A torn attempt preceded no executed child (execution only follows verified attempt read-back).
            expect(f.loaded[f.loaded.length - 1]).toBe(kind === "attempt" ? 7 : 6);
        }
    );
    it.each(["attempt", "accepted"])("process termination during %s write recovers on next startup", async (kind) => {
        const f = await fixture();
        const port = await staged(f);
        await port.activate(f.candidateSha256);
        const runtime = f.runtime();
        f.onWrite((path) => {
            if (path.includes(`${kind}-`)) {
                runtime.cancel();
                throw new Error("process terminated");
            }
        });
        await expect(runtime.start()).rejects.toThrow();
        f.onWrite(() => undefined);
        await f.runtime().start();
        expect(f.loaded[f.loaded.length - 1]).toBe(kind === "accepted" ? 7 : 6);
        expect(f.files.get(runtimePath(`${f.baselineSha256}.livesync-release`))).toEqual(f.baseline);
    });
    it("rejects an untrusted package even when the caller fabricates a verified result", async () => {
        const f = await fixture();
        const port = await staged(f);
        f.noKeys();
        await expect(port.stage(f.verified, f.candidateSha256)).rejects.toThrow("valid newer signed");
        await expect(port.activate(f.candidateSha256)).rejects.toThrow("valid signed newer");
    });
    it("refuses changed original signed bytes and never creates an intent", async () => {
        const f = await fixture();
        const port = await staged(f);
        await expect(
            port.stage({ ...f.verified, sourceBytes: bytesOf("tampered") }, f.candidateSha256)
        ).rejects.toThrow("hash differs");
        expect(f.files.has(runtimePath(`intent-${f.candidateSha256}.json`))).toBe(false);
    });
    it("does not evaluate a corrupt accepted package and recovers to baseline", async () => {
        const f = await fixture();
        const port = await staged(f);
        await port.activate(f.candidateSha256);
        await f.runtime().start();
        f.files.set(runtimePath(`${f.candidateSha256}.livesync-release`), bytesOf("corrupt"));
        await f.runtime().start();
        expect(f.loaded[f.loaded.length - 1]).toBe(6);
    });
    it("a pinned reader rejects mismatched hashes and cannot authorise a fresh vault update", async () => {
        const f = await fixture();
        f.noKeys();
        await expect(readPinnedReleasePackage(f.candidate, await f.env.verification(), "0".repeat(64))).rejects.toThrow(
            "local hash"
        );
        expect((await verifyReleasePackage(f.candidate, await f.env.verification())).status).toBe("rejected");
    });
    it("ignores an intent whose previous build was never accepted locally", async () => {
        const f = await fixture();
        await staged(f);
        f.files.set(
            runtimePath(`intent-${f.candidateSha256}.json`),
            packageBytesOf({ protocol: 1, packageSha256: f.candidateSha256, previousSha256: "0".repeat(64) })
        );
        await f.runtime().start();
        expect(f.loaded).toEqual([6, 6]);
    });
    it("refuses an incomplete baseline instead of executing any partial bytes", async () => {
        const f = await fixture();
        f.files.set(runtimePath(`${f.baselineSha256}.livesync-release`), bytesOf(""));
        await expect(f.runtime().start()).rejects.toThrow("hash differs");
        expect(f.loaded).toEqual([]);
    });
});
describe("the runtime subtree belongs only to local installation", () => {
    it.each([
        "",
        "/",
        "/abc.livesync-release",
        "/intent-abc.json",
        "/attempt-abc.json",
        "/accepted-abc.json",
        "/nested/x.js",
    ])("protects runtime path %s from every synced writer", (suffix) => {
        const write = createOwnPluginProtectedPathMatcher(directory);
        const remove = createOwnPluginRemovalProtectedPathMatcher(directory);
        const path = `${directory}/release-runtime${suffix}`;
        expect(write(path)).toBe(true);
        expect(remove(path)).toBe(true);
        expect(write(path.toUpperCase())).toBe(true);
        expect(write(path.split("/").join("\\"))).toBe(true);
    });
    it("does not protect a sibling folder or ordinary plugin settings", () => {
        const protectedPath = createOwnPluginProtectedPathMatcher(directory);
        expect(protectedPath(`${directory}/release-runtime-other/x`)).toBe(false);
        expect(protectedPath(`${directory}/data.json`)).toBe(false);
    });
});
