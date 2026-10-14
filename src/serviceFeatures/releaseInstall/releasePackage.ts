/**
 * Verification of a signed release package, format 1.
 *
 * Everything here is a pure function of its arguments: the bytes of the package file, the keys trusted on this
 * device, the identifier of this plug-in, the release number of the running build, and WebCrypto. The rules and
 * their order are those of `docs/release_install.md`; the first rule which does not hold decides the verdict.
 */
import {
    decodeCanonicalBase64,
    decodeStrictUtf8,
    findAsciiOccurrences,
    hasExactKeys,
    isPlainObject,
    sha256Hex,
} from "./releaseBytes";

/** A package is recognised by this extension alone. Its content, not its name, is authoritative. */
export const RELEASE_PACKAGE_EXTENSION = "livesync-release";
/** The only files a package holds and the only files an installation writes, sorted as the signed form sorts them. */
export const RELEASE_FILE_NAMES = ["main.js", "manifest.json", "styles.css"] as const;
export type ReleaseFileName = (typeof RELEASE_FILE_NAMES)[number];

const PACKAGE_FORMAT = 1;
const SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256";
const PACKAGE_KEYS = ["format", "pluginId", "releaseName", "releaseNumber", "files", "signature"];
const FILE_KEYS = ["name", "size", "sha256", "content"];
const SIGNATURE_KEYS = ["algorithm", "keyId", "value"];
// Identifiers are limited to characters which JSON never escapes, so the signed bytes cannot differ between
// JSON implementations.
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MARKER_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const KEY_ID_HEX_LENGTH = 16;
/** A P-256 signature in raw IEEE P1363 form is r followed by s, 32 bytes each. */
const SIGNATURE_BYTE_LENGTH = 64;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
// WebCrypto verifies ECDSA in raw IEEE P1363 form: r followed by s, 64 bytes for P-256.
const VERIFY_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const ASCII_ZERO = 48;
const ASCII_NINE = 57;

export type ReleaseRejectionCode =
    | "invalid-json"
    | "no-trusted-key"
    | "not-an-object"
    | "unknown-format"
    | "unknown-field"
    | "wrong-plugin-id"
    | "invalid-release-number"
    | "invalid-release-name"
    | "invalid-file-list"
    | "wrong-file-set"
    | "missing-signature"
    | "unknown-algorithm"
    | "unknown-key-id"
    | "bad-signature"
    | "invalid-file-content"
    | "file-size-mismatch"
    | "file-hash-mismatch"
    | "missing-release-marker"
    | "duplicate-release-marker"
    | "invalid-release-marker"
    | "release-marker-mismatch"
    | "invalid-manifest"
    | "wrong-manifest-id";

/** A public key trusted on this device, with the identifier computed from it here. */
export interface TrustedReleaseKey {
    /** The first 16 hexadecimal characters of the SHA-256 of the key's SPKI DER bytes. */
    keyId: string;
    key: CryptoKey;
}

export interface VerifiedReleaseFile {
    name: ReleaseFileName;
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
}

export interface VerifiedReleasePackage {
    /** Original signed envelope, retained for immutable bootstrap storage. */
    sourceBytes?: Uint8Array<ArrayBuffer>;
    releaseName: string;
    releaseNumber: number;
    keyId: string;
    /** The decoded files, in the order of {@link RELEASE_FILE_NAMES}. Nothing else may be written. */
    files: VerifiedReleaseFile[];
}

export type ReleasePackageVerdict =
    | { status: "verified"; package: VerifiedReleasePackage }
    /** A valid package which is not newer than the running build. It is passed over without a notice. */
    | { status: "not-newer"; releaseNumber: number }
    | { status: "rejected"; code: ReleaseRejectionCode };

export interface ReleaseVerificationContext {
    trustedKeys: readonly TrustedReleaseKey[];
    /** The identifier of the plug-in which verifies the package. */
    pluginId: string;
    /** The release number which the running build carries. */
    runningReleaseNumber: number;
    /** The text which precedes the release number in the `main.js` of a build. */
    markerPrefix: string;
    subtle: SubtleCrypto;
}

interface PackageFileEntry {
    name: string;
    size: number;
    sha256: string;
    content: string;
}

interface PackageSignature {
    algorithm: string;
    keyId: string;
    value: string;
}

class Rejection extends Error {
    constructor(readonly code: ReleaseRejectionCode) {
        super(code);
    }
}

function reject(code: ReleaseRejectionCode): never {
    throw new Rejection(code);
}

function isReleaseNumber(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFileEntry(entry: unknown): entry is PackageFileEntry {
    return (
        isPlainObject(entry) &&
        hasExactKeys(entry, FILE_KEYS) &&
        typeof entry.name === "string" &&
        Number.isSafeInteger(entry.size) &&
        (entry.size as number) >= 0 &&
        typeof entry.sha256 === "string" &&
        SHA256_PATTERN.test(entry.sha256) &&
        typeof entry.content === "string"
    );
}

function isSignature(signature: unknown): signature is PackageSignature {
    return (
        isPlainObject(signature) &&
        hasExactKeys(signature, SIGNATURE_KEYS) &&
        SIGNATURE_KEYS.every((key) => typeof signature[key] === "string")
    );
}

function compareNames(left: { name: string }, right: { name: string }): number {
    if (left.name < right.name) return -1;
    return left.name > right.name ? 1 : 0;
}

/** Key identifier: the first 16 hexadecimal characters of the SHA-256 of the public key's SPKI DER bytes. */
export async function releaseKeyId(subtle: SubtleCrypto, spkiDer: Uint8Array<ArrayBuffer>): Promise<string> {
    return (await sha256Hex(subtle, spkiDer)).slice(0, KEY_ID_HEX_LENGTH);
}

/** Import an ECDSA P-256 public key in SPKI DER form for verification. Anything else throws. */
export async function importReleaseKey(subtle: SubtleCrypto, spkiDer: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return await subtle.importKey("spki", spkiDer, KEY_ALGORITHM, false, ["verify"]);
}

/**
 * The signed bytes: UTF-8 of `JSON.stringify` of a freshly built object which holds everything except `signature`,
 * with this key order and the files sorted by name. Key order and white space of the package file never matter.
 */
export function canonicalReleasePackageBytes(releasePackage: {
    format: unknown;
    pluginId: unknown;
    releaseName: unknown;
    releaseNumber: unknown;
    files: readonly PackageFileEntry[];
}): Uint8Array<ArrayBuffer> {
    const canonical = {
        format: releasePackage.format,
        pluginId: releasePackage.pluginId,
        releaseName: releasePackage.releaseName,
        releaseNumber: releasePackage.releaseNumber,
        files: [...releasePackage.files]
            .sort(compareNames)
            .map((file) => ({ name: file.name, size: file.size, sha256: file.sha256, content: file.content })),
    };
    return new TextEncoder().encode(JSON.stringify(canonical));
}

/**
 * Read the release number which a build carries in its `main.js`. The prefix must occur exactly once, and the
 * digits which follow it must be a positive decimal integer without leading zeros.
 */
export function readReleaseMarker(mainJs: Uint8Array, markerPrefix: string): number {
    const occurrences = findAsciiOccurrences(mainJs, markerPrefix);
    if (occurrences.length === 0) reject("missing-release-marker");
    if (occurrences.length > 1) reject("duplicate-release-marker");
    let digits = "";
    for (let index = occurrences[0] + markerPrefix.length; index < mainJs.length; index++) {
        const byte = mainJs[index];
        if (byte < ASCII_ZERO || byte > ASCII_NINE) break;
        digits += String.fromCharCode(byte);
    }
    if (!MARKER_NUMBER_PATTERN.test(digits) || !isReleaseNumber(Number(digits))) reject("invalid-release-marker");
    return Number(digits);
}

function parsePackage(packageBytes: Uint8Array): unknown {
    try {
        return JSON.parse(decodeStrictUtf8(packageBytes));
    } catch {
        return reject("invalid-json");
    }
}

/** Rule 19: the decoded `manifest.json` bytes are valid UTF-8 and `JSON.parse` yields a plain object. */
function parseManifest(manifestBytes: Uint8Array): Record<string, unknown> {
    let manifest: unknown;
    try {
        manifest = JSON.parse(decodeStrictUtf8(manifestBytes));
    } catch {
        return reject("invalid-manifest");
    }
    if (!isPlainObject(manifest)) return reject("invalid-manifest");
    return manifest;
}

async function verify(
    packageBytes: Uint8Array,
    context: ReleaseVerificationContext,
    pinned = false
): Promise<ReleasePackageVerdict> {
    const { subtle } = context;
    // Rule 0
    const releasePackage = parsePackage(packageBytes);
    // Rule 1
    if (!pinned && context.trustedKeys.length === 0) reject("no-trusted-key");
    // Rule 2
    if (!isPlainObject(releasePackage)) reject("not-an-object");
    // Rule 3
    if (releasePackage.format !== PACKAGE_FORMAT) reject("unknown-format");
    // Rule 4
    if (!Object.keys(releasePackage).every((key) => PACKAGE_KEYS.includes(key))) reject("unknown-field");
    // Rule 5. The type test makes a missing expectation fail closed instead of matching a missing identifier.
    const { pluginId, releaseNumber, releaseName, files, signature } = releasePackage;
    if (typeof pluginId !== "string" || pluginId !== context.pluginId) reject("wrong-plugin-id");
    // Rule 6
    if (!isReleaseNumber(releaseNumber)) reject("invalid-release-number");
    // Rule 7
    if (typeof releaseName !== "string" || !LABEL_PATTERN.test(releaseName)) reject("invalid-release-name");
    // Rule 8
    if (!Array.isArray(files) || !files.every(isFileEntry)) reject("invalid-file-list");
    const entries: PackageFileEntry[] = files;
    // Rule 9
    const names = entries.map((file) => file.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(RELEASE_FILE_NAMES)) reject("wrong-file-set");
    // Rule 10
    if (!isSignature(signature)) reject("missing-signature");
    // Rule 11
    if (signature.algorithm !== SIGNATURE_ALGORITHM) reject("unknown-algorithm");
    // Rule 12. The identifiers compared here were computed on this device from the trusted keys themselves.
    const trusted = context.trustedKeys.find((candidate) => candidate.keyId === signature.keyId);
    if (!pinned && !trusted) reject("unknown-key-id");
    // Rule 13. The P1363 signature of P-256 is exactly 64 bytes (r followed by s). The length is checked here
    // rather than left to the engine, which need not reject a signature of another length by returning false.
    const signatureBytes = decodeCanonicalBase64(signature.value);
    const signatureHolds =
        pinned ||
        (signatureBytes !== null &&
            signatureBytes.length === SIGNATURE_BYTE_LENGTH &&
            (await subtle.verify(
                VERIFY_ALGORITHM,
                trusted!.key,
                signatureBytes,
                canonicalReleasePackageBytes({
                    format: PACKAGE_FORMAT,
                    pluginId,
                    releaseName,
                    releaseNumber,
                    files: entries,
                })
            )));
    if (!signatureHolds) reject("bad-signature");

    // No file content is decoded before this point.
    const decoded = new Map<string, VerifiedReleaseFile>();
    for (const file of entries) {
        // Rule 14
        const bytes = decodeCanonicalBase64(file.content);
        if (bytes === null) reject("invalid-file-content");
        // Rule 15
        if (bytes.length !== file.size) reject("file-size-mismatch");
        // Rule 16
        if ((await sha256Hex(subtle, bytes)) !== file.sha256) reject("file-hash-mismatch");
        decoded.set(file.name, { name: file.name as ReleaseFileName, bytes, sha256: file.sha256 });
    }
    const fileOf = (name: ReleaseFileName) => decoded.get(name) as VerifiedReleaseFile;
    // Rule 17: the build's own release marker is there, once and well formed.
    const releaseMarker = readReleaseMarker(fileOf("main.js").bytes, context.markerPrefix);
    // Rule 18: the build carries the release number which the package states.
    if (releaseMarker !== releaseNumber) reject("release-marker-mismatch");
    // Rule 19: the manifest.json inside the package parses as a plain object.
    const manifest = parseManifest(fileOf("manifest.json").bytes);
    // Rule 20: its id is a string exactly equal to the package's own pluginId (which rule 5 fixed to this plug-in).
    if (typeof manifest.id !== "string" || manifest.id !== pluginId) reject("wrong-manifest-id");
    // Device rule, after the format's rules: only a release newer than the running build is installed, without a
    // notice for one which is not.
    if (!(releaseNumber > context.runningReleaseNumber)) return { status: "not-newer", releaseNumber };

    return {
        status: "verified",
        package: {
            releaseName,
            releaseNumber,
            keyId: signature.keyId,
            files: RELEASE_FILE_NAMES.map(fileOf),
            sourceBytes: new Uint8Array(packageBytes),
        },
    };
}

/**
 * Verify the bytes of a package file.
 *
 * @returns The decoded files of a package which is valid and newer than the running build, the notice-free
 * verdict for a valid package which is not newer, or the code of the first rule which does not hold.
 */
export async function verifyReleasePackage(
    packageBytes: Uint8Array,
    context: ReleaseVerificationContext
): Promise<ReleasePackageVerdict> {
    try {
        return await verify(packageBytes, context);
    } catch (error) {
        if (error instanceof Rejection) return { status: "rejected", code: error.code };
        throw error;
    }
}

/**
 * Read a package authenticated by a device-local hash, established by initial installation or an accepted
 * signed update. This is never used to authorise a new update from the vault. All format/file checks remain.
 */
export async function readPinnedReleasePackage(
    bytes: Uint8Array,
    context: ReleaseVerificationContext,
    pinnedSha256: string
): Promise<VerifiedReleasePackage> {
    if (
        !/^[0-9a-f]{64}$/.test(pinnedSha256) ||
        (await sha256Hex(context.subtle, new Uint8Array(bytes))) !== pinnedSha256
    )
        throw new Error("The stored runtime package does not match its local hash");
    const verdict = await verify(bytes, { ...context, runningReleaseNumber: 0 }, true);
    if (verdict.status !== "verified") throw new Error("The stored runtime package is invalid");
    return verdict.package;
}
