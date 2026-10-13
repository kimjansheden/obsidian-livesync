import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The build carries its release number in `main.js` as this text followed by the number.
 * The plug-in source never spells the text: it receives the complete marker through one build-time constant.
 */
export const RELEASE_MARKER_PREFIX = "livesync-security-release:";
/** Name of the build-time constant which the plug-in source refers to, in exactly one place. */
export const RELEASE_MARKER_CONSTANT = "SECURITY_RELEASE_MARKER";

const MARKER_PATTERN = new RegExp(`${RELEASE_MARKER_PREFIX}([0-9]*)`, "gu");
const TAG_PATTERN = /^(?<version>[0-9]+\.[0-9]+\.[0-9]+)-security\.(?<number>[1-9][0-9]*)$/u;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isReleaseNumber(value) {
    return Number.isSafeInteger(value) && value > 0;
}

/**
 * The release number declared in `security-release.json`: a positive integer, or an error.
 * @param {{ releaseNumber?: unknown } | undefined} securityRelease
 * @returns {number}
 */
export function readReleaseNumber(securityRelease) {
    const releaseNumber = securityRelease?.releaseNumber;
    if (!isReleaseNumber(releaseNumber)) {
        throw new Error("security-release.json must declare releaseNumber as a positive integer.");
    }
    return releaseNumber;
}

/**
 * The value of the build-time constant: the literal marker text of this release.
 * @param {{ releaseNumber?: unknown } | undefined} securityRelease
 * @returns {string}
 */
export function releaseMarkerText(securityRelease) {
    return `${RELEASE_MARKER_PREFIX}${readReleaseNumber(securityRelease)}`;
}

/**
 * The built `main.js` must contain the marker prefix exactly once, followed by exactly the declared number.
 * Every occurrence of the prefix counts, also one which no number follows.
 * @param {{ mainJs: unknown, releaseNumber: unknown }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function evaluateReleaseMarker({ mainJs, releaseNumber }) {
    /** @type {string[]} */
    const errors = [];
    if (!isReleaseNumber(releaseNumber)) {
        return { ok: false, errors: ["The declared release number is not a positive integer."] };
    }
    if (!(mainJs instanceof Uint8Array)) {
        return { ok: false, errors: ["The built main.js could not be read."] };
    }
    // Latin-1 maps every byte to one character, so this is a search of the bytes for the ASCII marker.
    const markers = [...Buffer.from(mainJs).toString("latin1").matchAll(MARKER_PATTERN)];
    if (markers.length === 0) {
        errors.push("The built main.js does not carry the release marker.");
    } else if (markers.length > 1) {
        errors.push(`The built main.js carries the release marker prefix ${markers.length} times, not once.`);
    } else if (markers[0][1] !== `${releaseNumber}`) {
        errors.push(`The built main.js carries release number "${markers[0][1]}", not the declared ${releaseNumber}.`);
    }
    return { ok: errors.length === 0, errors };
}

/**
 * A release tag must be `<manifest version>-security.<releaseNumber>`.
 * @param {{ tag: unknown, manifestVersion: unknown, releaseNumber: unknown }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function evaluateReleaseTag({ tag, manifestVersion, releaseNumber }) {
    /** @type {string[]} */
    const errors = [];
    const parts = typeof tag === "string" ? TAG_PATTERN.exec(tag)?.groups : undefined;
    if (!parts) {
        return { ok: false, errors: ["The release tag is not <version>-security.<number>."] };
    }
    if (parts.version !== manifestVersion) {
        errors.push(`The release tag names version ${parts.version}, but manifest.json declares ${manifestVersion}.`);
    }
    if (parts.number !== `${releaseNumber}`) {
        errors.push(
            `The release tag names release ${parts.number}, but security-release.json declares ${releaseNumber}.`
        );
    }
    return { ok: errors.length === 0, errors };
}

function enforce(label, result) {
    if (!result.ok) {
        throw new Error(`${label} failed:\n- ${result.errors.join("\n- ")}`);
    }
    return result;
}

export function enforceReleaseMarker(input) {
    return enforce("Release marker policy", evaluateReleaseMarker(input));
}

export function enforceReleaseTag(input) {
    return enforce("Release tag policy", evaluateReleaseTag(input));
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * `--main <file>` checks a built `main.js`; `--tag <tag>` checks a release tag. Either or both may be given.
 */
export function runReleaseMarkerGate(args = process.argv.slice(2)) {
    const usage = "Usage: verify-release-marker.mjs [--main <built main.js>] [--tag <release tag>]";
    const options = { main: undefined, tag: undefined };
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index].startsWith("--") ? args[index].slice(2) : "";
        if (!Object.hasOwn(options, name) || args[index + 1] === undefined) throw new Error(usage);
        options[name] = args[index + 1];
    }
    if (options.main === undefined && options.tag === undefined) throw new Error(usage);
    const releaseNumber = readReleaseNumber(readJson("security-release.json"));
    if (options.tag !== undefined) {
        enforceReleaseTag({
            tag: options.tag,
            manifestVersion: readJson("manifest.json").version,
            releaseNumber,
        });
        console.log(`Release tag ${options.tag} names release ${releaseNumber} of the manifest version.`);
    }
    if (options.main !== undefined) {
        enforceReleaseMarker({ mainJs: readFileSync(options.main), releaseNumber });
        console.log(`${options.main} carries the release marker exactly once, with release number ${releaseNumber}.`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        runReleaseMarkerGate();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
