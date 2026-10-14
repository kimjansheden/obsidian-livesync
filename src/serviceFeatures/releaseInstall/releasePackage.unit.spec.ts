import { createPrivateKey, sign as signWithNodeCrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeCanonicalBase64, findAsciiOccurrences } from "./releaseBytes";
import {
    canonicalReleasePackageBytes,
    importReleaseKey,
    releaseKeyId,
    RELEASE_FILE_NAMES,
    verifyReleasePackage,
    type ReleaseVerificationContext,
} from "./releasePackage";
import {
    buildUnsigned,
    bytesOf,
    canonicalTextOf,
    encodeBase64,
    generateTestKey,
    mainJsOf,
    markerOf,
    packageBytesOf,
    replaceBytes,
    sha256HexOf,
    sign,
    signedAfter,
    subtle,
    TEST_PLUGIN_ID,
    TEST_RELEASE_NAME,
    TEST_RELEASE_NUMBER,
    testFiles,
    verificationContext,
    type TestKey,
    type TestPackage,
} from "./_releaseTestKit";

let KEY: TestKey;
let OTHER_KEY: TestKey;
beforeAll(async () => {
    KEY = await generateTestKey();
    OTHER_KEY = await generateTestKey();
});

const entryOf = (releasePackage: TestPackage, name: string) => releasePackage.files.find((file) => file.name === name)!;

/** The verdict in one word: the rejection code, or the status of a package which was not rejected. */
async function verdict(releasePackage: unknown, overrides: Partial<ReleaseVerificationContext> = {}) {
    const result = await verifyReleasePackage(packageBytesOf(releasePackage), verificationContext(KEY, overrides));
    return result.status === "rejected" ? result.code : result.status;
}

async function withSignature(change: (signature: NonNullable<TestPackage["signature"]>) => void | Promise<void>) {
    const signed = await signedAfter(KEY);
    await change(signed.signature!);
    return signed;
}

describe("a valid package", () => {
    it("is verified, and its decoded files are exactly the files it was built from", async () => {
        const signed = await signedAfter(KEY);
        const result = await verifyReleasePackage(packageBytesOf(signed), verificationContext(KEY));

        expect(result.status).toBe("verified");
        if (result.status !== "verified") return;
        expect(result.package.releaseName).toBe(TEST_RELEASE_NAME);
        expect(result.package.releaseNumber).toBe(TEST_RELEASE_NUMBER);
        expect(result.package.keyId).toBe(KEY.keyId);
        expect(result.package.files.map((file) => file.name)).toEqual([...RELEASE_FILE_NAMES]);
        const files = testFiles();
        for (const file of result.package.files) {
            expect(file.bytes).toEqual(files[file.name]);
            expect(file.sha256).toBe(await sha256HexOf(files[file.name]));
        }
    });

    it("is verified whatever the white space, the key order and the file order of the package file", async () => {
        const signed = await signedAfter(KEY);
        const reordered = Object.fromEntries(Object.entries(signed).reverse()) as TestPackage;
        reordered.files = [...signed.files]
            .reverse()
            .map((file) => Object.fromEntries(Object.entries(file).reverse())) as TestPackage["files"];
        for (const text of [JSON.stringify(signed, null, 4), JSON.stringify(reordered, null, "\t")]) {
            const result = await verifyReleasePackage(bytesOf(text), verificationContext(KEY));
            expect(result.status).toBe("verified");
        }
    });

    it("is verified with any of several trusted keys", async () => {
        const signed = await signedAfter(OTHER_KEY);

        expect(await verdict(signed, { trustedKeys: [KEY.trusted, OTHER_KEY.trusted] })).toBe("verified");
    });

    it("has exactly the documented signed bytes, whatever the order in the file", async () => {
        const signed = await signedAfter(KEY);
        const files = testFiles();
        const fileTexts = [];
        for (const name of RELEASE_FILE_NAMES) {
            fileTexts.push(
                `{"name":"${name}","size":${files[name].length},"sha256":"${await sha256HexOf(files[name])}","content":"${encodeBase64(files[name])}"}`
            );
        }
        const expected = `{"format":1,"pluginId":"${TEST_PLUGIN_ID}","releaseName":"${TEST_RELEASE_NAME}","releaseNumber":${TEST_RELEASE_NUMBER},"files":[${fileTexts.join(",")}]}`;

        expect(new TextDecoder().decode(canonicalReleasePackageBytes(signed))).toBe(expected);
        expect(canonicalTextOf(signed)).toBe(expected);
        const reversed = { ...signed, files: [...signed.files].reverse() };
        expect(canonicalReleasePackageBytes(reversed)).toEqual(canonicalReleasePackageBytes(signed));
    });
});

describe("the synthetic example of the format document", () => {
    it("verifies with its published key, and its signed text matches byte for byte", async () => {
        const document = await readFile("docs/release_install.md", "utf8");
        const blocks = [...document.matchAll(/```(json|text)\r?\n([\s\S]*?)\r?\n```/gu)];
        const example = JSON.parse(blocks.find(([, language]) => language === "json")![2]) as TestPackage;
        const [publicKey, canonicalText] = blocks
            .filter(([, language]) => language === "text")
            .map(([, , body]) => body);
        const spki = decodeCanonicalBase64(publicKey)!;
        const keyId = await releaseKeyId(subtle, spki);
        const context: ReleaseVerificationContext = {
            trustedKeys: [{ keyId, key: await importReleaseKey(subtle, spki) }],
            pluginId: example.pluginId,
            runningReleaseNumber: example.releaseNumber - 1,
            // The example's `main.js` is nothing but a comment which holds the marker.
            markerPrefix: markerOf(""),
            subtle,
        };

        expect(example.signature!.keyId).toBe(keyId);
        expect(new TextDecoder().decode(canonicalReleasePackageBytes(example))).toBe(canonicalText);
        const result = await verifyReleasePackage(bytesOf(JSON.stringify(example)), context);
        expect(result.status).toBe("verified");
        if (result.status !== "verified") return;
        expect(new TextDecoder().decode(result.package.files[0].bytes)).toBe(`/*${markerOf(example.releaseNumber)}*/`);
        expect(result.package.files[2].bytes).toHaveLength(0);
        // The same package is no longer newer once its build runs.
        const afterwards = await verifyReleasePackage(bytesOf(JSON.stringify(example)), {
            ...context,
            runningReleaseNumber: example.releaseNumber,
        });
        expect(afterwards).toEqual({ status: "not-newer", releaseNumber: example.releaseNumber });
    });
});

// One case per verification rule. Each package is signed with the trusted key after the change, so only the named
// rule stands between the package and acceptance.
type RuleCase = [
    code: string,
    description: string,
    makePackage: () => Promise<unknown>,
    overrides?: Partial<ReleaseVerificationContext>,
];
const RULE_CASES: RuleCase[] = [
    ["no-trusted-key", "no trusted key", () => signedAfter(KEY), { trustedKeys: [] }],
    ["not-an-object", "the package is a list", async () => [await signedAfter(KEY)]],
    ["not-an-object", "the package is null", async () => null],
    ["not-an-object", "the package is a string", async () => "package"],
    ["unknown-format", "format 2", () => signedAfter(KEY, (p) => void (p.format = 2))],
    ["unknown-format", "format as a string", () => signedAfter(KEY, (p) => void (p.format = "1" as never))],
    ["unknown-field", "an unknown field at the top level", () => signedAfter(KEY, (p) => void (p.note = "x"))],
    ["wrong-plugin-id", "another plug-in's identifier", () => signedAfter(KEY, (p) => void (p.pluginId = "other"))],
    [
        "wrong-plugin-id",
        "no identifier, and none expected",
        () => signedAfter(KEY, (p) => void delete (p as Partial<TestPackage>).pluginId),
        { pluginId: undefined as unknown as string },
    ],
    ["invalid-release-number", "release number 0", () => signedAfter(KEY, (p) => void (p.releaseNumber = 0))],
    ["invalid-release-number", "a negative release number", () => signedAfter(KEY, (p) => void (p.releaseNumber = -3))],
    [
        "invalid-release-number",
        "a fractional release number",
        () => signedAfter(KEY, (p) => void (p.releaseNumber = 7.5)),
    ],
    [
        "invalid-release-number",
        "a release number as a string",
        () => signedAfter(KEY, (p) => void (p.releaseNumber = "7" as never)),
    ],
    [
        "invalid-release-number",
        "a release number beyond the safe integers",
        () => signedAfter(KEY, (p) => void (p.releaseNumber = 2 ** 53)),
    ],
    [
        "invalid-release-name",
        "a release name with a space",
        () => signedAfter(KEY, (p) => void (p.releaseName = "a b")),
    ],
    ["invalid-release-name", "an empty release name", () => signedAfter(KEY, (p) => void (p.releaseName = ""))],
    [
        "invalid-release-name",
        "a release name which is a number",
        () => signedAfter(KEY, (p) => void (p.releaseName = 7 as never)),
    ],
    [
        "invalid-file-list",
        "a file entry with an unknown field",
        () => signedAfter(KEY, (p) => void ((p.files[0] as never as Record<string, string>).mode = "x")),
    ],
    [
        "invalid-file-list",
        "a size as a string",
        () => signedAfter(KEY, (p) => void (p.files[0].size = `${p.files[0].size}` as never)),
    ],
    ["invalid-file-list", "a negative size", () => signedAfter(KEY, (p) => void (p.files[0].size = -1))],
    [
        "invalid-file-list",
        "a hash in upper case",
        () => signedAfter(KEY, (p) => void (p.files[0].sha256 = p.files[0].sha256.toUpperCase())),
    ],
    [
        "invalid-file-list",
        "a file list which is not a list",
        async () => ({ ...(await signedAfter(KEY)), files: "main.js" }),
    ],
    [
        "invalid-file-list",
        "a file entry which is null",
        async () => {
            const signed = await signedAfter(KEY);
            signed.files[1] = null as never;
            return signed;
        },
    ],
    ["wrong-file-set", "a missing file", () => signedAfter(KEY, (p) => void p.files.pop())],
    [
        "wrong-file-set",
        "an additional file",
        () => signedAfter(KEY, (p) => void p.files.push({ ...p.files[0], name: "data.json" })),
    ],
    [
        "wrong-file-set",
        "a path instead of a file name",
        () => signedAfter(KEY, (p) => void (p.files[0].name = "../main.js")),
    ],
    [
        "wrong-file-set",
        "one file twice instead of another",
        () => signedAfter(KEY, (p) => void (p.files[2] = { ...p.files[0] })),
    ],
    [
        "wrong-file-set",
        "one file twice beside the three",
        () => signedAfter(KEY, (p) => void p.files.push({ ...p.files[0] })),
    ],
    [
        "wrong-file-set",
        "a file name in another case",
        () => signedAfter(KEY, (p) => void (p.files[0].name = "Main.js")),
    ],
    [
        "missing-signature",
        "no signature",
        async () => {
            const { signature: _removed, ...unsigned } = await signedAfter(KEY);
            return unsigned;
        },
    ],
    [
        "missing-signature",
        "a signature which is a string",
        async () => ({ ...(await signedAfter(KEY)), signature: "AAAA" }),
    ],
    [
        "missing-signature",
        "a signature without a value",
        () => withSignature((signature) => void delete (signature as Partial<typeof signature>).value),
    ],
    [
        "missing-signature",
        "a signature with an additional field",
        () => withSignature((signature) => void Object.assign(signature, { note: "x" })),
    ],
    ["unknown-algorithm", "another algorithm", () => withSignature((s) => void (s.algorithm = "ECDSA-P384-SHA384"))],
    ["unknown-key-id", "signed with a key which is not trusted", () => signedAfter(OTHER_KEY)],
    [
        "unknown-key-id",
        "a valid signature under another key identifier",
        () => withSignature((s) => void (s.keyId = OTHER_KEY.keyId)),
    ],
    [
        "bad-signature",
        "another key's signature under the trusted key's identifier",
        async () => {
            const signed = await signedAfter(OTHER_KEY);
            signed.signature!.keyId = KEY.keyId;
            return signed;
        },
    ],
    [
        "bad-signature",
        "one bit changed in the signature",
        () =>
            withSignature((s) => {
                const bytes = Buffer.from(s.value, "base64");
                bytes[10] ^= 0x01;
                s.value = bytes.toString("base64");
            }),
    ],
    [
        "bad-signature",
        "a signature one byte short",
        () => withSignature((s) => void (s.value = Buffer.from(s.value, "base64").subarray(0, 63).toString("base64"))),
    ],
    [
        "bad-signature",
        "a signature one byte long",
        () =>
            withSignature((s) => void (s.value = encodeBase64(new Uint8Array([...Buffer.from(s.value, "base64"), 0])))),
    ],
    [
        "bad-signature",
        "a valid signature in DER form instead of r followed by s",
        async () => {
            const signed = await signedAfter(KEY);
            const pkcs8 = Buffer.from(await subtle.exportKey("pkcs8", KEY.privateKey));
            const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
            const der = signWithNodeCrypto("sha256", bytesOf(canonicalTextOf(signed)), {
                key: privateKey,
                dsaEncoding: "der",
            });
            signed.signature!.value = der.toString("base64");
            return signed;
        },
    ],
    [
        "bad-signature",
        "a valid signature in another base64 spelling",
        () => withSignature((s) => void (s.value = s.value.replace(/=+$/u, ""))),
    ],
    ["bad-signature", "an empty signature", () => withSignature((s) => void (s.value = ""))],
    // "QQ" decodes to the same byte as "QQ==" in a lenient decoder, so size and hash still match.
    [
        "invalid-file-content",
        "base64 without padding",
        () =>
            signedAfter(KEY, async (p) => {
                await replaceBytes(p.files[2], bytesOf("A"));
                p.files[2].content = "QQ";
            }),
    ],
    // "QR==" has stray bits in its last character and decodes to the same byte as "QQ==".
    [
        "invalid-file-content",
        "base64 with stray bits in the last character",
        () =>
            signedAfter(KEY, async (p) => {
                await replaceBytes(p.files[2], bytesOf("A"));
                p.files[2].content = "QR==";
            }),
    ],
    [
        "invalid-file-content",
        "base64 with a line break",
        () => signedAfter(KEY, (p) => void (p.files[0].content = `${p.files[0].content}\n`)),
    ],
    [
        "invalid-file-content",
        "base64 in the URL-safe alphabet",
        () =>
            signedAfter(KEY, async (p) => {
                await replaceBytes(p.files[2], new Uint8Array([0xfb, 0xff, 0xfe]));
                p.files[2].content = "-__-";
            }),
    ],
    ["file-size-mismatch", "a stated size which differs", () => signedAfter(KEY, (p) => void (p.files[1].size += 1))],
    [
        "file-hash-mismatch",
        "content changed while the hash stayed",
        () =>
            signedAfter(KEY, (p) => {
                const bytes = Buffer.from(p.files[1].content, "base64");
                bytes[0] ^= 0x01;
                p.files[1].content = bytes.toString("base64");
            }),
    ],
    [
        "file-hash-mismatch",
        "a hash changed while the content stayed",
        () => signedAfter(KEY, async (p) => void (p.files[2].sha256 = await sha256HexOf(bytesOf("other")))),
    ],
    [
        "missing-release-marker",
        "a main.js without the marker",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf("no marker here"))),
    ],
    [
        "missing-release-marker",
        "the marker only in another file",
        () =>
            signedAfter(KEY, async (p) => {
                await replaceBytes(entryOf(p, "main.js"), mainJsOf("no marker here"));
                await replaceBytes(entryOf(p, "styles.css"), bytesOf(`/* ${markerOf(TEST_RELEASE_NUMBER)} */`));
            }),
    ],
    [
        "duplicate-release-marker",
        "the marker twice with the same number",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(`${markerOf(7)} ${markerOf(7)}`))),
    ],
    [
        "duplicate-release-marker",
        "the marker's text once more without a number",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(`${markerOf(7)} ${markerOf("")}`))),
    ],
    [
        "invalid-release-marker",
        "a marker number with a leading zero",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf("07")))),
    ],
    [
        "invalid-release-marker",
        "a marker without a number",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf("x")))),
    ],
    [
        "invalid-release-marker",
        "a marker at the very end of the file",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), bytesOf(markerOf("")))),
    ],
    [
        "invalid-release-marker",
        "a marker number of zero",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf(0)))),
    ],
    [
        "invalid-release-marker",
        "a marker number beyond the safe integers",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf(2 ** 53)))),
    ],
    [
        "release-marker-mismatch",
        "a main.js which carries another number than the package states",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf(8)))),
    ],
    [
        "release-marker-mismatch",
        "a package number which is only the beginning of the marker's",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "main.js"), mainJsOf(markerOf(70)))),
    ],
    [
        "release-marker-mismatch",
        "a package which states another number than its main.js carries",
        () => signedAfter(KEY, (p) => void (p.releaseNumber = 8)),
    ],
    [
        "invalid-manifest",
        "a manifest which is not JSON",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "manifest.json"), bytesOf("{"))),
    ],
    [
        "invalid-manifest",
        "a manifest which is not UTF-8",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "manifest.json"), new Uint8Array([0x22, 0xff, 0x22]))),
    ],
    [
        "invalid-manifest",
        "a manifest which is a list",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "manifest.json"), bytesOf(`["${TEST_PLUGIN_ID}"]`))),
    ],
    [
        "wrong-manifest-id",
        "a manifest of another plug-in",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "manifest.json"), bytesOf('{"id":"other-plugin"}'))),
    ],
    [
        "wrong-manifest-id",
        "a manifest without an identifier",
        () => signedAfter(KEY, (p) => replaceBytes(entryOf(p, "manifest.json"), bytesOf('{"version":"0.0.1"}'))),
    ],
];

describe("verification rules", () => {
    it.each(RULE_CASES)("reject with %s: %s", async (code, _description, makePackage, overrides) => {
        expect(await verdict(await makePackage(), overrides)).toBe(code);
    });

    it("rejects a package file which is not JSON, not UTF-8, or empty", async () => {
        const text = JSON.stringify(await signedAfter(KEY));
        const context = verificationContext(KEY);
        // Bytes which are not UTF-8, inside a string so that a lenient decoder would still yield valid JSON.
        const invalidUtf8 = new Uint8Array([...bytesOf('{"format":"'), 0xff, ...bytesOf('"}')]);
        for (const bytes of [bytesOf(text.slice(0, -1)), invalidUtf8, new Uint8Array(0)]) {
            expect(await verifyReleasePackage(bytes, context)).toEqual({ status: "rejected", code: "invalid-json" });
        }
        // Rule 0 comes before rule 1.
        expect(await verifyReleasePackage(new Uint8Array(0), { ...context, trustedKeys: [] })).toEqual({
            status: "rejected",
            code: "invalid-json",
        });
    });

    it("applies the rules in their documented order", async () => {
        const base = await signedAfter(KEY);
        const broken = (change: (p: TestPackage) => void) => {
            const copy = structuredClone(base);
            change(copy);
            return copy;
        };
        const cases: [string, TestPackage][] = [
            ["unknown-format", broken((p) => Object.assign(p, { format: 2, note: "x", pluginId: "other" }))],
            ["unknown-field", broken((p) => Object.assign(p, { note: "x", pluginId: "other" }))],
            ["wrong-plugin-id", broken((p) => Object.assign(p, { pluginId: "other", releaseNumber: 0 }))],
            ["invalid-release-number", broken((p) => Object.assign(p, { releaseNumber: 0, releaseName: "" }))],
            ["invalid-release-name", broken((p) => Object.assign(p, { releaseName: "", files: [] }))],
            ["invalid-file-list", broken((p) => Object.assign(p, { files: [{}], signature: undefined }))],
            ["wrong-file-set", broken((p) => Object.assign(p, { files: p.files.slice(1), signature: undefined }))],
            ["missing-signature", broken((p) => Object.assign(p, { signature: { algorithm: "other" } }))],
            ["unknown-algorithm", broken((p) => Object.assign(p.signature!, { algorithm: "x", keyId: "y" }))],
            ["unknown-key-id", broken((p) => Object.assign(p.signature!, { keyId: OTHER_KEY.keyId, value: "" }))],
        ];
        for (const [code, releasePackage] of cases) expect(await verdict(releasePackage)).toBe(code);
    });

    it("decodes no file content before the signature is accepted", async () => {
        const signed = await signedAfter(KEY);
        // Content which is not base64 at all, a wrong size and a wrong hash, under a signature which does not hold.
        signed.files[0].content = "not base64!";
        signed.files[1].size += 1;
        signed.files[2].sha256 = "0".repeat(64);

        expect(await verdict(signed)).toBe("bad-signature");
    });

    it("checks content, size and hash of one file before it looks at the next", async () => {
        const hashFirst = await signedAfter(KEY, (p) => {
            p.files[0].sha256 = "0".repeat(64);
            p.files[1].content = "not base64!";
        });
        const sizeFirst = await signedAfter(KEY, (p) => {
            p.files[0].size += 1;
            p.files[1].content = "not base64!";
        });
        const contentSecond = await signedAfter(KEY, (p) => void (p.files[1].content = "not base64!"));

        expect(await verdict(hashFirst)).toBe("file-hash-mismatch");
        expect(await verdict(sizeFirst)).toBe("file-size-mismatch");
        expect(await verdict(contentSecond)).toBe("invalid-file-content");
        // The order is that of the package file, not of the names.
        const reversed = { ...hashFirst, files: [...hashFirst.files].reverse() };
        expect(await verdict(await sign(reversed, KEY))).toBe("invalid-file-content");
    });

    it("breaks the signature with one changed byte in any file, also when size and hash are corrected", async () => {
        const signed = await signedAfter(KEY);
        const files = testFiles();
        for (const name of RELEASE_FILE_NAMES) {
            for (let index = 0; index < files[name].length; index += 1) {
                const changed = new Uint8Array(files[name]);
                changed[index] ^= 0x01;
                const contentOnly = structuredClone(signed);
                entryOf(contentOnly, name).content = encodeBase64(changed);
                expect(await verdict(contentOnly), `${name} byte ${index}`).toBe("bad-signature");
                const consistent = structuredClone(signed);
                await replaceBytes(entryOf(consistent, name), changed);
                expect(await verdict(consistent), `${name} byte ${index}, hash corrected`).toBe("bad-signature");
            }
        }
    });

    it("breaks the signature when anything else which is signed is changed", async () => {
        const signed = await signedAfter(KEY);
        const changed = (apply: (p: TestPackage) => void) => {
            const copy = structuredClone(signed);
            apply(copy);
            return copy;
        };
        expect(await verdict(changed((p) => void (p.releaseNumber += 1)))).toBe("bad-signature");
        expect(await verdict(changed((p) => void (p.releaseNumber -= 1)))).toBe("bad-signature");
        expect(await verdict(changed((p) => void (p.releaseName = `${TEST_RELEASE_NAME}x`)))).toBe("bad-signature");
        // The package is retargeted at another plug-in, and that plug-in is the one which checks it.
        expect(
            await verdict(
                changed((p) => void (p.pluginId = "other-plugin")),
                { pluginId: "other-plugin" }
            )
        ).toBe("bad-signature");
        expect(await verdict(changed((p) => void (p.files[0].size += 1)))).toBe("bad-signature");
        // Two files trade names, so the set of names is still the right one.
        expect(
            await verdict(
                changed((p) => {
                    [p.files[0].name, p.files[2].name] = [p.files[2].name, p.files[0].name];
                })
            )
        ).toBe("bad-signature");
    });
});

describe("the signature length", () => {
    it("is checked before the engine, so a signature which is not 64 bytes is refused without a verify call", async () => {
        const signed = await signedAfter(KEY);
        // A 63-byte signature: WebCrypto would return false, but the length check should refuse it first.
        signed.signature!.value = encodeBase64(
            new Uint8Array(Buffer.from(signed.signature!.value, "base64")).subarray(0, 63)
        );
        const verify = vi.spyOn(subtle, "verify");
        try {
            expect(await verdict(signed)).toBe("bad-signature");
            expect(verify).not.toHaveBeenCalled();
        } finally {
            verify.mockRestore();
        }
    });

    it("lets a 64-byte signature through to the engine, which then rejects a forgery", async () => {
        const forged = await signedAfter(KEY);
        const bytes = new Uint8Array(Buffer.from(forged.signature!.value, "base64"));
        bytes[0] ^= 0x01;
        forged.signature!.value = encodeBase64(bytes);
        const verify = vi.spyOn(subtle, "verify");
        try {
            expect(await verdict(forged)).toBe("bad-signature");
            expect(verify).toHaveBeenCalledOnce();
        } finally {
            verify.mockRestore();
        }
    });
});

describe("release number against the running build", () => {
    it.each([
        ["the same release", TEST_RELEASE_NUMBER],
        ["an older release", TEST_RELEASE_NUMBER + 5],
    ])("passes over %s without rejecting it", async (_, runningReleaseNumber) => {
        const signed = await signedAfter(KEY);

        expect(
            await verifyReleasePackage(packageBytesOf(signed), verificationContext(KEY, { runningReleaseNumber }))
        ).toEqual({ status: "not-newer", releaseNumber: TEST_RELEASE_NUMBER });
    });

    it("rejects an older package which is not valid, instead of passing over it", async () => {
        const signed = await signedAfter(OTHER_KEY);

        expect(await verdict(signed, { runningReleaseNumber: TEST_RELEASE_NUMBER + 5 })).toBe("unknown-key-id");
    });

    it("passes over every package when the running build does not know its own number", async () => {
        const signed = await signedAfter(KEY);

        expect(await verdict(signed, { runningReleaseNumber: Number.NaN })).toBe("not-newer");
    });

    it("accepts a release one above the running one", async () => {
        const signed = await signedAfter(KEY);

        expect(await verdict(signed, { runningReleaseNumber: TEST_RELEASE_NUMBER - 1 })).toBe("verified");
    });
});

describe("byte helpers", () => {
    it("decodes base64 only in its single canonical spelling", () => {
        expect(decodeCanonicalBase64("")).toEqual(new Uint8Array(0));
        for (const bytes of [
            [0],
            [0, 1],
            [0, 1, 2],
            [255, 254, 253, 252],
            Array.from({ length: 300 }, (_, i) => i % 256),
        ]) {
            expect(decodeCanonicalBase64(encodeBase64(new Uint8Array(bytes)))).toEqual(new Uint8Array(bytes));
        }
        for (const text of [
            "QQ",
            "QQ=",
            "QQ= ",
            "QR==",
            "QUJ=",
            "Q===",
            "====",
            "QQ==\n",
            " QQ==",
            "QQ==QQ==",
            "-_-_",
            "Qé==",
            7,
            null,
        ]) {
            expect(decodeCanonicalBase64(text), String(text)).toBeNull();
        }
    });

    it("finds a text in bytes without overlap, also among bytes which are not text", () => {
        const bytes = new Uint8Array([0xff, ...bytesOf("abab-abab"), 0x00, ...bytesOf("ab")]);

        expect(findAsciiOccurrences(bytes, "abab")).toEqual([1, 6]);
        expect(findAsciiOccurrences(bytesOf("aaaa"), "aa")).toEqual([0, 2]);
        expect(findAsciiOccurrences(bytes, "abc")).toEqual([]);
        expect(findAsciiOccurrences(bytes, "")).toEqual([]);
    });

    it("derives a key identifier from the DER bytes of the public key", async () => {
        const der = decodeCanonicalBase64(KEY.spkiBase64)!;

        expect(await releaseKeyId(subtle, der)).toBe((await sha256HexOf(der)).slice(0, 16));
        expect(await releaseKeyId(subtle, der)).toBe(KEY.keyId);
        expect(KEY.keyId).not.toBe(OTHER_KEY.keyId);
    });

    it("signs the unsigned package it was given, so the fixtures do not depend on the code under test", async () => {
        const unsigned = await buildUnsigned();

        expect(new TextDecoder().decode(canonicalReleasePackageBytes(unsigned))).toBe(canonicalTextOf(unsigned));
    });
});
