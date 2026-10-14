/** Immutable runtime packages and activation records for the permanent bootstrap (protocol 1). */
import { decodeCanonicalBase64, decodeStrictUtf8, hasExactKeys, isPlainObject, sha256Hex } from "./releaseBytes";
import {
    readPinnedReleasePackage,
    readReleaseMarker,
    RELEASE_FILE_NAMES,
    verifyReleasePackage,
    type ReleaseVerificationContext,
    type VerifiedReleasePackage,
} from "./releasePackage";

export const RELEASE_RUNTIME_DIRECTORY = "release-runtime";
export const BOOTSTRAP_PROTOCOL = 1;
const HASH = /^[0-9a-f]{64}$/;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const RECORD_FIELDS = ["protocol", "packageSha256", "previousSha256"];
export interface ReleaseRuntimeAdapter {
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[] }>;
}
export interface BootstrapRuntimePort {
    readonly protocol: 1;
    readonly payloadSha256: string;
    readonly packageSha256: string;
    stage(verified: VerifiedReleasePackage, sha256: string): Promise<void>;
    activate(sha256: string): Promise<void>;
}
interface RuntimeRecord {
    protocol: 1;
    packageSha256: string;
    previousSha256: string;
}
interface StoredRuntime {
    sha256: string;
    verified: VerifiedReleasePackage;
}
export interface ReleaseRuntimeEnvironment {
    adapter: ReleaseRuntimeAdapter;
    pluginDirectory: string;
    baselineSha256: string;
    verification: () => Promise<ReleaseVerificationContext>;
    wait(milliseconds: number): Promise<void>;
    retryDelaysMs: readonly number[];
    /** Must clean up a partially loaded child before rejecting. */
    load(verified: VerifiedReleasePackage, port: BootstrapRuntimePort): Promise<void>;
    notify(message: string): void;
}

/** No active executable or record is ever replaced. Torn new files cannot invalidate an earlier build. */
export class ReleaseRuntime {
    private cancelled = false;
    constructor(private readonly env: ReleaseRuntimeEnvironment) {
        if (!HASH.test(env.baselineSha256)) throw new Error("A bootstrap requires a pinned baseline package");
    }
    cancel(): void {
        this.cancelled = true;
    }
    private path(name: string): string {
        return `${this.env.pluginDirectory}/${RELEASE_RUNTIME_DIRECTORY}/${name}`;
    }
    private packagePath(sha256: string): string {
        if (!HASH.test(sha256)) throw new Error("Invalid runtime package hash");
        return this.path(`${sha256}.livesync-release`);
    }
    private recordPath(kind: "intent" | "attempt" | "accepted", sha256: string): string {
        if (!HASH.test(sha256)) throw new Error("Invalid runtime record hash");
        return this.path(`${kind}-${sha256}.json`);
    }
    private ensureRunning(): void {
        if (this.cancelled) throw new Error("The bootstrap has unloaded");
    }
    private async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
        return new Uint8Array(await this.env.adapter.readBinary(path));
    }
    private async put(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const sha256 = await sha256Hex((await this.env.verification()).subtle, bytes);
        for (const pause of [0, ...this.env.retryDelaysMs]) {
            this.ensureRunning();
            if (pause) await this.env.wait(pause);
            try {
                // An existing complete immutable file needs no write. Partial, never accepted files may be retried.
                if (
                    (await this.env.adapter.exists(path)) &&
                    (await sha256Hex((await this.env.verification()).subtle, await this.read(path))) === sha256
                )
                    return;
                await this.env.adapter.writeBinary(path, bytes.slice().buffer);
                if ((await sha256Hex((await this.env.verification()).subtle, await this.read(path))) === sha256) return;
            } catch {
                /* A transient storage read/write is retried within the same finite budget. */
            }
        }
        throw new Error("The immutable runtime file could not be written and read back intact");
    }
    private async readRecord(
        kind: "intent" | "attempt" | "accepted",
        sha256: string
    ): Promise<RuntimeRecord | undefined> {
        try {
            const bytes = await this.read(this.recordPath(kind, sha256));
            if (bytes.length > 1024) return undefined;
            const value: unknown = JSON.parse(decodeStrictUtf8(bytes));
            if (
                !isPlainObject(value) ||
                !hasExactKeys(value, RECORD_FIELDS) ||
                value.protocol !== 1 ||
                value.packageSha256 !== sha256 ||
                typeof value.previousSha256 !== "string" ||
                !HASH.test(value.previousSha256)
            )
                return undefined;
            return value as unknown as RuntimeRecord;
        } catch {
            return undefined;
        }
    }
    private async writeRecord(kind: "intent" | "attempt" | "accepted", record: RuntimeRecord): Promise<void> {
        const existing = await this.readRecord(kind, record.packageSha256);
        if (existing && existing.previousSha256 !== record.previousSha256)
            throw new Error("An immutable runtime record already names another previous build");
        await this.put(this.recordPath(kind, record.packageSha256), new TextEncoder().encode(JSON.stringify(record)));
    }
    private async pinned(sha256: string): Promise<StoredRuntime> {
        const bytes = await this.read(this.packagePath(sha256));
        if (bytes.length > MAX_PACKAGE_BYTES) throw new Error("The runtime package exceeds its size limit");
        const context = await this.env.verification();
        return {
            sha256,
            verified:
                sha256 === this.env.baselineSha256
                    ? await readBootstrapBaseline(bytes, context, sha256)
                    : await readPinnedReleasePackage(bytes, context, sha256),
        };
    }
    private async signed(sha256: string, runningReleaseNumber: number): Promise<StoredRuntime> {
        const bytes = await this.read(this.packagePath(sha256));
        const context = await this.env.verification();
        if (bytes.length > MAX_PACKAGE_BYTES || (await sha256Hex(context.subtle, new Uint8Array(bytes))) !== sha256)
            throw new Error("The candidate package hash does not match");
        const verdict = await verifyReleasePackage(bytes, { ...context, runningReleaseNumber });
        if (verdict.status !== "verified")
            throw new Error("The candidate runtime package is not a valid signed newer release");
        return { sha256, verified: verdict.package };
    }
    private async names(kind: "intent" | "accepted"): Promise<string[]> {
        const listing = await this.env.adapter.list(this.path(""));
        const pattern = new RegExp(`^${kind}-([0-9a-f]{64})\\.json$`);
        return listing.files
            .map((path) => path.split("/").pop() ?? "")
            .map((name) => pattern.exec(name)?.[1])
            .filter((sha): sha is string => Boolean(sha));
    }
    private port(runtime: StoredRuntime): BootstrapRuntimePort {
        const main = runtime.verified.files.find((file) => file.name === "main.js")!;
        return {
            protocol: 1,
            payloadSha256: main.sha256,
            packageSha256: runtime.sha256,
            stage: async (verified, sha256) => {
                this.ensureRunning();
                if (!verified.sourceBytes || verified.sourceBytes.length > MAX_PACKAGE_BYTES)
                    throw new Error("The original signed envelope is required");
                const context = await this.env.verification();
                if ((await sha256Hex(context.subtle, verified.sourceBytes)) !== sha256)
                    throw new Error("The signed envelope hash differs");
                const verdict = await verifyReleasePackage(verified.sourceBytes, {
                    ...context,
                    runningReleaseNumber: runtime.verified.releaseNumber,
                });
                if (verdict.status !== "verified")
                    throw new Error("The staged package is not a valid newer signed release");
                await this.put(this.packagePath(sha256), verified.sourceBytes);
            },
            // This closure survives unload of the child. The permanent executable never changes.
            activate: async (sha256) => {
                await this.signed(sha256, runtime.verified.releaseNumber);
                await new ReleaseRuntime(this.env).writeRecord("intent", {
                    protocol: 1,
                    packageSha256: sha256,
                    previousSha256: runtime.sha256,
                });
            },
        };
    }
    async start(): Promise<void> {
        const { adapter } = this.env;
        if (!(await adapter.exists(this.path("")))) throw new Error("The bootstrap baseline directory is missing");
        const baseline = await this.pinned(this.env.baselineSha256);
        const accepted: StoredRuntime[] = [baseline];
        for (const sha256 of await this.names("accepted")) {
            if (!(await this.readRecord("accepted", sha256))) continue;
            try {
                accepted.push(await this.pinned(sha256));
            } catch {
                /* A corrupt accepted payload cannot be executed. */
            }
        }
        accepted.sort((a, b) => b.verified.releaseNumber - a.verified.releaseNumber);
        const previous = accepted[0];
        const candidates: { runtime: StoredRuntime; record: RuntimeRecord }[] = [];
        for (const sha256 of await this.names("intent")) {
            const record = await this.readRecord("intent", sha256);
            if (!record || (await this.readRecord("attempt", sha256)) || (await this.readRecord("accepted", sha256)))
                continue;
            // An intent can only advance from a known local accepted build, never from a vault-supplied pointer.
            if (!accepted.some((item) => item.sha256 === record.previousSha256)) continue;
            try {
                candidates.push({ runtime: await this.signed(sha256, previous.verified.releaseNumber), record });
            } catch {
                /* Invalid/incomplete candidates leave the accepted build intact. */
            }
        }
        candidates.sort((a, b) => b.runtime.verified.releaseNumber - a.runtime.verified.releaseNumber);
        for (const candidate of candidates.slice(0, 1)) {
            try {
                await this.writeRecord("attempt", candidate.record);
                this.ensureRunning();
                await this.env.load(candidate.runtime.verified, this.port(candidate.runtime));
                this.ensureRunning();
                await this.writeRecord("accepted", candidate.record);
                this.ensureRunning();
                return;
            } catch (error) {
                this.ensureRunning();
                this.env.notify(
                    `The candidate runtime did not load; restoring the previous release (${String(error)}).`
                );
            }
        }
        for (const runtime of accepted) {
            this.ensureRunning();
            try {
                await this.env.load(runtime.verified, this.port(runtime));
                return;
            } catch {
                this.ensureRunning();
            }
        }
        throw new Error("Neither the previous LiveSync release nor its bootstrap baseline could load");
    }
}

/** The initial install artifact is authenticated by the hash compiled into the permanent loader, never by sync. */
export async function readBootstrapBaseline(
    bytes: Uint8Array,
    context: ReleaseVerificationContext,
    pinnedSha256: string
): Promise<VerifiedReleasePackage> {
    if ((await sha256Hex(context.subtle, new Uint8Array(bytes))) !== pinnedSha256)
        throw new Error("The baseline hash differs");
    const parsed: unknown = JSON.parse(decodeStrictUtf8(bytes));
    if (
        !isPlainObject(parsed) ||
        !hasExactKeys(parsed, ["format", "pluginId", "releaseNumber", "files"]) ||
        parsed.format !== "livesync-bootstrap-baseline:1" ||
        parsed.pluginId !== context.pluginId ||
        !Number.isSafeInteger(parsed.releaseNumber) ||
        Number(parsed.releaseNumber) < 1 ||
        !Array.isArray(parsed.files)
    )
        throw new Error("Invalid bootstrap baseline");
    const files: VerifiedReleasePackage["files"] = [];
    for (const name of RELEASE_FILE_NAMES) {
        const entries = parsed.files.filter((entry: unknown) => isPlainObject(entry) && entry.name === name);
        if (entries.length !== 1 || parsed.files.length !== RELEASE_FILE_NAMES.length)
            throw new Error("Invalid baseline file set");
        const entry = entries[0] as Record<string, unknown>;
        if (
            !hasExactKeys(entry, ["name", "size", "sha256", "content"]) ||
            typeof entry.sha256 !== "string" ||
            !HASH.test(entry.sha256) ||
            typeof entry.content !== "string"
        )
            throw new Error("Invalid baseline file");
        const content = decodeCanonicalBase64(entry.content);
        if (!content || content.length !== entry.size || (await sha256Hex(context.subtle, content)) !== entry.sha256)
            throw new Error("Invalid baseline file hash");
        files.push({ name, bytes: content, sha256: entry.sha256 });
    }
    if (readReleaseMarker(files[0].bytes, context.markerPrefix) !== parsed.releaseNumber)
        throw new Error("Invalid baseline release marker");
    const manifest: unknown = JSON.parse(decodeStrictUtf8(files[1].bytes));
    if (!isPlainObject(manifest) || manifest.id !== context.pluginId) throw new Error("Invalid baseline manifest");
    return {
        releaseName: `baseline-${String(parsed.releaseNumber)}`,
        releaseNumber: Number(parsed.releaseNumber),
        keyId: "local-baseline",
        files,
    };
}
