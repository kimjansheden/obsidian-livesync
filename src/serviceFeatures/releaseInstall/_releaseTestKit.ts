/**
 * Synthetic release packages for the unit tests. The keys are generated for each test run and the files are
 * made-up bytes; nothing here is a real key, name or release.
 *
 * The package is built and signed here without the code under test, so the tests compare two implementations of
 * the signed form.
 */
import { RELEASE_MARKER_PREFIX } from "./runningRelease";
import type { ReleaseVerificationContext, TrustedReleaseKey } from "./releasePackage";

export const subtle = crypto.subtle;
export const TEST_PLUGIN_ID = "example-plugin";
export const TEST_RELEASE_NUMBER = 7;
export const TEST_RELEASE_NAME = `0.0.1-security.${TEST_RELEASE_NUMBER}`;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

export interface TestKey {
    privateKey: CryptoKey;
    /** The public key as base64 of its SPKI DER form: one entry of the trusted-keys file. */
    spkiBase64: string;
    keyId: string;
    trusted: TrustedReleaseKey;
}

export interface TestFileEntry {
    name: string;
    size: number;
    sha256: string;
    content: string;
}

export interface TestPackage {
    format: number;
    pluginId: string;
    releaseName: string;
    releaseNumber: number;
    files: TestFileEntry[];
    signature?: { algorithm: string; keyId: string; value: string };
    [extra: string]: unknown;
}

export const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export const bytesOf = (text: string) => new TextEncoder().encode(text);

export async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return Buffer.from(await subtle.digest("SHA-256", bytes)).toString("hex");
}

export async function generateTestKey(): Promise<TestKey> {
    const pair = await subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
    const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
    const keyId = (await sha256HexOf(spki)).slice(0, 16);
    return {
        privateKey: pair.privateKey,
        spkiBase64: encodeBase64(spki),
        keyId,
        trusted: { keyId, key: await subtle.importKey("spki", spki, KEY_ALGORITHM, false, ["verify"]) },
    };
}

/** The text which a build of release `number` carries in its `main.js`. */
export const markerOf = (number: number | string) => `${RELEASE_MARKER_PREFIX}${number}`;
/** A synthetic `main.js` whose comment holds whatever the test wants in the place of the release marker. */
export const mainJsOf = (comment: string) => bytesOf(`module.exports = "synthetic main"; // ${comment}\n`);

export function testFiles(releaseNumber = TEST_RELEASE_NUMBER, pluginId = TEST_PLUGIN_ID) {
    return {
        "main.js": mainJsOf(markerOf(releaseNumber)),
        "manifest.json": bytesOf(JSON.stringify({ id: pluginId, version: "0.0.1" })),
        "styles.css": bytesOf(".synthetic { color: red; }\n"),
    };
}

export async function fileEntry(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<TestFileEntry> {
    return { name, size: bytes.length, sha256: await sha256HexOf(bytes), content: encodeBase64(bytes) };
}

export async function replaceBytes(entry: TestFileEntry, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    Object.assign(entry, await fileEntry(entry.name, bytes));
}

export async function buildUnsigned(
    releaseNumber = TEST_RELEASE_NUMBER,
    files: Record<string, Uint8Array<ArrayBuffer>> = testFiles(releaseNumber)
): Promise<TestPackage> {
    const entries: TestFileEntry[] = [];
    for (const name of Object.keys(files).sort()) entries.push(await fileEntry(name, files[name]));
    return {
        format: 1,
        pluginId: TEST_PLUGIN_ID,
        releaseName: `0.0.1-security.${releaseNumber}`,
        releaseNumber,
        files: entries,
    };
}

/** The signed text, written out as the format defines it. */
export function canonicalTextOf(releasePackage: TestPackage): string {
    const files = [...releasePackage.files]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, content: f.content }));
    return JSON.stringify({
        format: releasePackage.format,
        pluginId: releasePackage.pluginId,
        releaseName: releasePackage.releaseName,
        releaseNumber: releasePackage.releaseNumber,
        files,
    });
}

export async function sign(unsigned: TestPackage, key: TestKey): Promise<TestPackage> {
    const signature = await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        bytesOf(canonicalTextOf(unsigned))
    );
    return {
        ...unsigned,
        signature: { algorithm: "ECDSA-P256-SHA256", keyId: key.keyId, value: encodeBase64(new Uint8Array(signature)) },
    };
}

/**
 * Build the package, let the caller change anything in it, and sign the result. A rejection of such a package is
 * therefore the work of one rule, not of the signature.
 */
export async function signedAfter(
    key: TestKey,
    change: (unsigned: TestPackage) => void | Promise<void> = () => {},
    releaseNumber = TEST_RELEASE_NUMBER
): Promise<TestPackage> {
    const unsigned = await buildUnsigned(releaseNumber);
    await change(unsigned);
    return await sign(unsigned, key);
}

export const packageBytesOf = (releasePackage: unknown) => bytesOf(JSON.stringify(releasePackage));

export function verificationContext(
    key: TestKey,
    overrides: Partial<ReleaseVerificationContext> = {}
): ReleaseVerificationContext {
    return {
        trustedKeys: [key.trusted],
        pluginId: TEST_PLUGIN_ID,
        runningReleaseNumber: TEST_RELEASE_NUMBER - 1,
        markerPrefix: RELEASE_MARKER_PREFIX,
        subtle,
        ...overrides,
    };
}

/** The folder of the synthetic plug-in, relative to the synthetic vault. */
export const TEST_PLUGIN_DIRECTORY = `.config/plugins/${TEST_PLUGIN_ID}`;
export const pluginFile = (name: string) => `${TEST_PLUGIN_DIRECTORY}/${name}`;

/**
 * A file adapter in memory. `intercept` lets a test fail an operation or falsify what a read returns, the way a
 * device's storage sometimes does.
 */
export class MemoryAdapter {
    readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
    /** Every operation, in order, as `<operation> <path>`. */
    readonly operations: string[] = [];
    /** What a rename onto an existing file does; adapters differ. */
    renameOntoExisting: "refuse" | "replace" = "refuse";
    intercept: {
        read?: (path: string, stored: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
        write?: (path: string) => void;
        remove?: (path: string) => void;
        rename?: (from: string, to: string) => void;
    } = {};

    private stored(path: string): Uint8Array<ArrayBuffer> {
        const bytes = this.files.get(path);
        if (!bytes) throw new Error(`ENOENT: ${path}`);
        return bytes;
    }

    exists = (path: string) => Promise.resolve(this.files.has(path));

    readBinary = async (path: string): Promise<ArrayBuffer> => {
        this.operations.push(`read ${path}`);
        const stored = this.stored(path);
        const bytes = this.intercept.read?.(path, stored) ?? stored;
        return await Promise.resolve(bytes.slice().buffer);
    };

    writeBinary = async (path: string, data: ArrayBuffer): Promise<void> => {
        this.operations.push(`write ${path}`);
        this.intercept.write?.(path);
        this.files.set(path, new Uint8Array(data.slice(0)));
        await Promise.resolve();
    };

    remove = async (path: string): Promise<void> => {
        this.operations.push(`remove ${path}`);
        this.intercept.remove?.(path);
        this.stored(path);
        this.files.delete(path);
        await Promise.resolve();
    };

    rename = async (from: string, to: string): Promise<void> => {
        this.operations.push(`rename ${from} -> ${to}`);
        this.intercept.rename?.(from, to);
        const bytes = this.stored(from);
        if (this.files.has(to) && this.renameOntoExisting === "refuse") {
            throw new Error("Destination file already exists!");
        }
        this.files.set(to, bytes);
        this.files.delete(from);
        await Promise.resolve();
    };

    /** The files of the plug-in's folder as text, for comparing a state with an earlier one. */
    snapshot(): Record<string, string> {
        return Object.fromEntries([...this.files].map(([path, bytes]) => [path, encodeBase64(bytes)]).sort());
    }

    /** Paths which were written, removed, or the target of a rename. */
    changedPaths(): string[] {
        const changed = this.operations
            .filter((operation) => !operation.startsWith("read "))
            .flatMap((operation) => operation.replace(/^\w+ /u, "").split(" -> "));
        return [...new Set(changed)].sort();
    }
}

export interface SyntheticInstance {
    securityRelease: { releaseNumber: number; loadState: "loading" | "loaded" | "failed" };
}

const MARKER_IN_BUILD = new RegExp(`${RELEASE_MARKER_PREFIX}([0-9]+)`, "u");

/**
 * What the synthetic host makes of a `main.js`: a loaded instance which reports the release its marker states, or
 * nothing at all for a build whose text contains `throw`, as when a real build throws while it is loaded.
 */
export function loadSyntheticBuild(mainJs: Uint8Array | undefined): SyntheticInstance | undefined {
    const text = mainJs ? new TextDecoder().decode(mainJs) : "";
    const releaseNumber = MARKER_IN_BUILD.exec(text)?.[1];
    if (!releaseNumber || text.includes("throw")) return undefined;
    return { securityRelease: { releaseNumber: Number(releaseNumber), loadState: "loaded" } };
}

/** The plug-in manager of a synthetic host. It loads whatever `main.js` is in the plug-in's folder. */
export class SyntheticPluginHost {
    instance: unknown;
    loadBuild: (mainJs: Uint8Array | undefined) => unknown = loadSyntheticBuild;

    constructor(
        private readonly adapter: MemoryAdapter,
        instance: unknown
    ) {
        this.instance = instance;
    }

    disablePlugin = (_pluginId: string): Promise<void> => {
        this.adapter.operations.push("disablePlugin");
        this.instance = undefined;
        return Promise.resolve();
    };

    enablePlugin = async (_pluginId: string): Promise<void> => {
        this.adapter.operations.push("enablePlugin");
        this.instance = await this.loadBuild(this.adapter.files.get(pluginFile("main.js")));
    };

    loadManifests = (): Promise<void> => {
        this.adapter.operations.push("loadManifests");
        return Promise.resolve();
    };

    getInstance = (_pluginId: string): unknown => this.instance;
}

/** Install the files of the synthetic build of `releaseNumber` in the synthetic plug-in folder. */
export function installSyntheticBuild(adapter: MemoryAdapter, releaseNumber: number): void {
    adapter.files.set(pluginFile("main.js"), mainJsOf(`installed ${markerOf(releaseNumber)}`));
    adapter.files.set(pluginFile("manifest.json"), bytesOf(JSON.stringify({ id: TEST_PLUGIN_ID, version: "0.0.0" })));
    adapter.files.set(pluginFile("styles.css"), bytesOf(".installed {}\n"));
    adapter.files.set(pluginFile("data.json"), bytesOf('{"synthetic":"settings"}'));
}
