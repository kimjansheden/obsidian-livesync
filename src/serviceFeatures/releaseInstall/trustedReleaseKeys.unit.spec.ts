import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
    DEFAULT_SETTINGS,
    TweakValuesTemplate,
    type ObsidianLiveSyncSettings,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { RELEASE_MARKER_PREFIX, RUNNING_RELEASE_NUMBER } from "./runningRelease";
import {
    createTrustedReleaseKeysPathMatcher,
    parseTrustedReleaseKeys,
    pluginDirectoryOf,
    TRUSTED_RELEASE_KEYS_FILE,
} from "./trustedReleaseKeys";
import { bytesOf, encodeBase64, generateTestKey, subtle, type TestKey } from "./_releaseTestKit";

let KEY: TestKey;
let OTHER_KEY: TestKey;
beforeAll(async () => {
    KEY = await generateTestKey();
    OTHER_KEY = await generateTestKey();
});

const parse = (content: unknown) =>
    parseTrustedReleaseKeys(bytesOf(typeof content === "string" ? content : JSON.stringify(content)), subtle);

describe("the trusted-keys file", () => {
    it("yields the keys with identifiers computed from the keys themselves", async () => {
        const result = await parse({ format: 1, keys: [KEY.spkiBase64, OTHER_KEY.spkiBase64] });

        expect(result.status).toBe("valid");
        if (result.status !== "valid") return;
        expect(result.keys.map((key) => key.keyId)).toEqual([KEY.keyId, OTHER_KEY.keyId]);
        expect(result.keys.every((key) => key.key.type === "public" && key.key.usages.includes("verify"))).toBe(true);
    });

    it("accepts one to eight keys, whatever the white space and key order of the file", async () => {
        const eight = { keys: Array.from({ length: 8 }, () => KEY.spkiBase64), format: 1 };

        expect((await parse(JSON.stringify(eight, null, 4))).status).toBe("valid");
        expect((await parse({ format: 1, keys: [KEY.spkiBase64] })).status).toBe("valid");
    });

    it.each<[string, () => unknown]>([
        ["text which is not JSON", () => '{"format":1,'],
        ["an empty file", () => ""],
        ["a list", () => [KEY.spkiBase64]],
        ["null", () => null],
        ["an additional field", () => ({ format: 1, keys: [KEY.spkiBase64], comment: "x" })],
        ["a missing format", () => ({ keys: [KEY.spkiBase64] })],
        ["a missing key list", () => ({ format: 1 })],
        ["another format", () => ({ format: 2, keys: [KEY.spkiBase64] })],
        ["a format as a string", () => ({ format: "1", keys: [KEY.spkiBase64] })],
        ["no key", () => ({ format: 1, keys: [] })],
        ["nine keys", () => ({ format: 1, keys: Array.from({ length: 9 }, () => KEY.spkiBase64) })],
        ["a key list which is a string", () => ({ format: 1, keys: KEY.spkiBase64 })],
        ["a key which is not a string", () => ({ format: 1, keys: [KEY.spkiBase64, 7] })],
        ["an empty key", () => ({ format: 1, keys: [""] })],
        ["a key without its padding", () => ({ format: 1, keys: [KEY.spkiBase64.replace(/=+$/u, "")] })],
        ["a key with a line break", () => ({ format: 1, keys: [`${KEY.spkiBase64}\n`] })],
        ["a key with surrounding space", () => ({ format: 1, keys: [` ${KEY.spkiBase64}`] })],
        ["bytes which are not a key", () => ({ format: 1, keys: [encodeBase64(bytesOf("not a key at all"))] })],
        [
            "a key on another curve",
            async () => {
                const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
                return {
                    format: 1,
                    keys: [encodeBase64(new Uint8Array(await subtle.exportKey("spki", pair.publicKey)))],
                };
            },
        ],
        [
            "a private key",
            async () => {
                const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", KEY.privateKey));
                return { format: 1, keys: [encodeBase64(pkcs8)] };
            },
        ],
        ["one invalid key among valid ones", () => ({ format: 1, keys: [KEY.spkiBase64, "AAAA"] })],
    ])("is not valid with %s", async (_, makeContent) => {
        const result = await parse(await makeContent());

        expect(result.status).toBe("invalid");
        // The reason names what is wrong and never quotes the file.
        if (result.status === "invalid") expect(result.reason).not.toContain(KEY.spkiBase64.slice(0, 24));
    });

    it("is not valid when it is not UTF-8", async () => {
        const bytes = new Uint8Array([...bytesOf('{"format":1,"keys":["'), 0xff, ...bytesOf('"]}')]);

        expect(await parseTrustedReleaseKeys(bytes, subtle)).toEqual({
            status: "invalid",
            reason: "it is not JSON in UTF-8",
        });
    });
});

describe("the path of the trusted-keys file", () => {
    const directory = ".obsidian/plugins/example-plugin";
    const isProtected = createTrustedReleaseKeysPathMatcher(directory);

    it.each([
        `${directory}/${TRUSTED_RELEASE_KEYS_FILE}`,
        `.Obsidian/Plugins/Example-Plugin/Trusted-Release-Keys.JSON`,
        `.obsidian//plugins/example-plugin///${TRUSTED_RELEASE_KEYS_FILE}`,
        `./.obsidian/plugins/./example-plugin/${TRUSTED_RELEASE_KEYS_FILE}`,
        `/.obsidian/plugins/example-plugin/${TRUSTED_RELEASE_KEYS_FILE}`,
        `.obsidian\\plugins\\example-plugin\\${TRUSTED_RELEASE_KEYS_FILE}`,
        `.obsidian/plugins/other/../example-plugin/${TRUSTED_RELEASE_KEYS_FILE}`,
        `${directory}/${TRUSTED_RELEASE_KEYS_FILE}.`,
        `${directory}/${TRUSTED_RELEASE_KEYS_FILE} `,
        `${directory}/${TRUSTED_RELEASE_KEYS_FILE}::$DATA`,
    ])("recognises %j", (path) => {
        expect(isProtected(path)).toBe(true);
    });

    it.each([
        `${directory}/main.js`,
        `${directory}/data.json`,
        `${directory}/${TRUSTED_RELEASE_KEYS_FILE}.bak`,
        `${directory}/copy-of-${TRUSTED_RELEASE_KEYS_FILE}`,
        `${directory}/nested/${TRUSTED_RELEASE_KEYS_FILE}`,
        `.obsidian/plugins/another-plugin/${TRUSTED_RELEASE_KEYS_FILE}`,
        `notes/${TRUSTED_RELEASE_KEYS_FILE}`,
        TRUSTED_RELEASE_KEYS_FILE,
        directory,
        "",
    ])("leaves %j alone", (path) => {
        expect(isProtected(path)).toBe(false);
    });

    it("answers for a value which is not a path", () => {
        expect(isProtected(undefined as unknown as string)).toBe(false);
    });

    it("matches a path given in another Unicode normalisation than the folder it protects", () => {
        // A directory whose name has a precomposed character; the path arrives decomposed.
        const precomposed = ".obsidian/stáging/plugins/example-plugin"; // 'á' as one code point
        const match = createTrustedReleaseKeysPathMatcher(precomposed.normalize("NFC"));

        expect(match(`${precomposed.normalize("NFC")}/${TRUSTED_RELEASE_KEYS_FILE}`)).toBe(true);
        expect(match(`${precomposed.normalize("NFD")}/${TRUSTED_RELEASE_KEYS_FILE}`)).toBe(true);
    });

    it("takes the plug-in's folder from the manifest, or from the configuration folder and the identifier", () => {
        const app = { vault: { configDir: ".config" } };

        expect(pluginDirectoryOf({ manifest: { id: "p", dir: ".custom/plugins/p" }, app })).toBe(".custom/plugins/p");
        expect(pluginDirectoryOf({ manifest: { id: "p" }, app })).toBe(".config/plugins/p");
    });
});

describe("the trusted keys are not a setting", () => {
    it("has no counterpart in the settings, which are what a Setup URI, a QR code and the settings Markdown hold", () => {
        const names = Object.keys(DEFAULT_SETTINGS as ObsidianLiveSyncSettings).concat(
            Object.keys(TweakValuesTemplate)
        );

        expect(names.filter((name) => /trusted|releasekey|securityrelease|releaseinstall/iu.test(name))).toEqual([]);
    });
});

describe("the release number of the running build", () => {
    it("is the one which security-release.json declares, read from the build's marker", () => {
        const declared = JSON.parse(readFileSync("security-release.json", "utf8")) as { releaseNumber: number };

        expect(RUNNING_RELEASE_NUMBER).toBe(declared.releaseNumber);
        expect(Number.isSafeInteger(RUNNING_RELEASE_NUMBER) && RUNNING_RELEASE_NUMBER > 0).toBe(true);
        expect(RELEASE_MARKER_PREFIX.endsWith(":")).toBe(true);
        expect(RELEASE_MARKER_PREFIX).not.toMatch(/[0-9]/u);
    });

    it("spells the marker prefix nowhere in the source which is bundled", async () => {
        const { readdir, readFile } = await import("node:fs/promises");
        const offenders: string[] = [];
        const visit = async (directory: string) => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                const path = `${directory}/${entry.name}`;
                if (entry.isDirectory()) await visit(path);
                else if (/\.(?:ts|svelte|js|json)$/u.test(entry.name) && !/\.spec\.ts$/u.test(entry.name)) {
                    if ((await readFile(path, "utf8")).includes(RELEASE_MARKER_PREFIX)) offenders.push(path);
                }
            }
        };
        await visit("src");
        // The change log is embedded in the bundle.
        if ((await readFile("updates.md", "utf8")).includes(RELEASE_MARKER_PREFIX)) offenders.push("updates.md");

        expect(offenders).toEqual([]);
    });
});
