/**
 * The trust anchor of release installation: the file `trusted-release-keys.json` in the plug-in's own folder.
 *
 * Whoever can write that folder can already replace the plug-in's code, so the keys are exactly as protected as
 * the code they gate. The plug-in only ever reads the file; it never writes, replaces or removes it.
 */
import { decodeCanonicalBase64, decodeStrictUtf8, hasExactKeys, isPlainObject } from "./releaseBytes";
import { importReleaseKey, releaseKeyId, type TrustedReleaseKey } from "./releasePackage";

export const TRUSTED_RELEASE_KEYS_FILE = "trusted-release-keys.json";

const TRUSTED_KEYS_FORMAT = 1;
const TRUSTED_KEYS_FIELDS = ["format", "keys"];
const MAX_TRUSTED_KEYS = 8;

export type TrustedReleaseKeysResult =
    | { status: "valid"; keys: TrustedReleaseKey[] }
    /** `reason` names what is wrong with the file. It never quotes the file's content. */
    | { status: "invalid"; reason: string };

/**
 * Parse the trusted-keys file strictly: `{ "format": 1, "keys": [...] }` with exactly those two fields and one to
 * eight keys, each the base64 of the SPKI DER form of an ECDSA P-256 public key, in the single accepted spelling.
 */
export async function parseTrustedReleaseKeys(
    fileBytes: Uint8Array,
    subtle: SubtleCrypto
): Promise<TrustedReleaseKeysResult> {
    const invalid = (reason: string): TrustedReleaseKeysResult => ({ status: "invalid", reason });
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeStrictUtf8(fileBytes));
    } catch {
        return invalid("it is not JSON in UTF-8");
    }
    if (!isPlainObject(parsed) || !hasExactKeys(parsed, TRUSTED_KEYS_FIELDS)) {
        return invalid('it must hold exactly the fields "format" and "keys"');
    }
    if (parsed.format !== TRUSTED_KEYS_FORMAT) return invalid(`"format" must be ${TRUSTED_KEYS_FORMAT}`);
    const encodedKeys: unknown = parsed.keys;
    if (!Array.isArray(encodedKeys) || encodedKeys.length < 1 || encodedKeys.length > MAX_TRUSTED_KEYS) {
        return invalid(`"keys" must list 1 to ${MAX_TRUSTED_KEYS} keys`);
    }
    const keys: TrustedReleaseKey[] = [];
    for (const [index, encoded] of encodedKeys.entries()) {
        const der = decodeCanonicalBase64(encoded);
        if (der === null || der.length === 0)
            return invalid(`key ${index + 1} is not base64 in its canonical spelling`);
        try {
            keys.push({ keyId: await releaseKeyId(subtle, der), key: await importReleaseKey(subtle, der) });
        } catch {
            return invalid(`key ${index + 1} is not an ECDSA P-256 public key in SPKI form`);
        }
    }
    return { status: "valid", keys };
}

/**
 * Bring a vault-relative path into one spelling for comparison on a case-insensitive file system: forward
 * slashes, no empty or `.` segments, `..` resolved, Unicode NFC, lower case, and per segment neither the trailing
 * dots and spaces nor the stream suffix which some file systems ignore.
 */
function normaliseForComparison(path: string): string {
    const segments: string[] = [];
    for (const raw of path.split("\\").join("/").split("/")) {
        if (raw === "..") {
            segments.pop();
            continue;
        }
        const segment = raw.split(":")[0].replace(/[. ]+$/u, "");
        if (segment !== "") segments.push(segment);
    }
    return segments.join("/").normalize("NFC").toLowerCase();
}

/**
 * Create the test which every writer and remover of the plug-in applies: does `path` address the trusted-keys
 * file of the plug-in in `pluginDirectory`?
 */
export function createTrustedReleaseKeysPathMatcher(pluginDirectory: string): (path: string) => boolean {
    const protectedPath = normaliseForComparison(`${pluginDirectory}/${TRUSTED_RELEASE_KEYS_FILE}`);
    return (path) => typeof path === "string" && normaliseForComparison(path) === protectedPath;
}

/** This plug-in's own files which installation owns: the signed executable files and the trusted-keys file. */
export const OWN_PLUGIN_PROTECTED_FILES = ["main.js", "manifest.json", "styles.css", TRUSTED_RELEASE_KEYS_FILE];

/**
 * Create the test which keeps synchronisation off this plug-in's own installed files: the signed executable files
 * (`main.js`, `manifest.json`, `styles.css`) and the trusted-keys file, all in the plug-in's own `pluginDirectory`.
 * Those change only through the signed-release install path, never from a synchronised record. Files of other
 * plug-ins, and any other file in this plug-in's own folder, are not matched, so their sync is unaffected.
 */
export function createOwnPluginProtectedPathMatcher(pluginDirectory: string): (path: string) => boolean {
    const protectedPaths = new Set(
        OWN_PLUGIN_PROTECTED_FILES.map((name) => normaliseForComparison(`${pluginDirectory}/${name}`))
    );
    return (path) => typeof path === "string" && protectedPaths.has(normaliseForComparison(path));
}

/**
 * Create the test a remove or rename applies, which keeps those operations from destroying this plug-in's own
 * installed files: it answers true for the protected files themselves and for the plug-in's own directory and
 * every ancestor of it, since removing or renaming any of those takes the protected files with it. A sibling
 * plug-in's directory, an unrelated directory, and this plug-in's own `data.json` are not matched, so they stay
 * removable. The spellings are folded as for the file matcher; aliased and symbolic-link spellings are refused by
 * the alias and link guards, which run beside this test.
 */
export function createOwnPluginRemovalProtectedPathMatcher(pluginDirectory: string): (path: string) => boolean {
    const isProtectedFile = createOwnPluginProtectedPathMatcher(pluginDirectory);
    const pluginDirectoryNormalised = normaliseForComparison(pluginDirectory);
    return (path) => {
        if (typeof path !== "string") return false;
        if (isProtectedFile(path)) return true;
        const target = normaliseForComparison(path);
        // The plug-in directory itself, or an ancestor of it: removing or renaming it would take the plug-in with it.
        return target !== "" && (pluginDirectoryNormalised === target || pluginDirectoryNormalised.startsWith(`${target}/`));
    };
}

/** The plug-in's own folder, relative to the vault: the folder which the host loaded it from. */
export function pluginDirectoryOf(plugin: {
    manifest: { id: string; dir?: string };
    app: { vault: { configDir: string } };
}): string {
    return plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
}
