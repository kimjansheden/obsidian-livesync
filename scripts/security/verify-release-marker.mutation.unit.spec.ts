import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import securityRelease from "../../security-release.json" with { type: "json" };

import {
    RELEASE_MARKER_PREFIX,
    enforceReleaseMarker,
    enforceReleaseTag,
    evaluateReleaseMarker,
    evaluateReleaseTag,
    readReleaseNumber,
    releaseMarkerText,
} from "./verify-release-marker.mjs";

const bundle = (text: string) => new TextEncoder().encode(`var before = 1;\n${text}\nvar after = 2;\n`);
const marker = (number: number | string) => `${RELEASE_MARKER_PREFIX}${number}`;

describe("release number declaration", () => {
    it("reads a positive integer and builds the marker text from it", () => {
        expect(readReleaseNumber({ releaseNumber: 11 })).toBe(11);
        expect(releaseMarkerText({ releaseNumber: 11 })).toBe(`${RELEASE_MARKER_PREFIX}11`);
    });

    it.each([
        ["a missing number", {}],
        ["a missing declaration", undefined],
        ["zero", { releaseNumber: 0 }],
        ["a negative number", { releaseNumber: -1 }],
        ["a fraction", { releaseNumber: 1.5 }],
        ["a string", { releaseNumber: "11" }],
        ["a number beyond the safe integers", { releaseNumber: 2 ** 53 }],
    ])("refuses %s", (_, declaration) => {
        expect(() => readReleaseNumber(declaration)).toThrow("releaseNumber as a positive integer");
        expect(() => releaseMarkerText(declaration)).toThrow("releaseNumber as a positive integer");
    });
});

describe("release marker in the built main.js", () => {
    it("accepts the prefix exactly once, followed by exactly the declared number", () => {
        const input = { mainJs: bundle(`var m = "${marker(11)}";`), releaseNumber: 11 };

        expect(evaluateReleaseMarker(input)).toEqual({ ok: true, errors: [] });
        expect(() => enforceReleaseMarker(input)).not.toThrow();
    });

    it("searches bytes, so content which is not UTF-8 does not hide the marker", () => {
        const mainJs = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode(marker(11)), 0x00, 0x80]);

        expect(evaluateReleaseMarker({ mainJs, releaseNumber: 11 })).toEqual({ ok: true, errors: [] });
    });

    it.each([
        ["no marker", bundle("var m = 11;"), "does not carry the release marker"],
        ["the marker twice", bundle(`"${marker(11)}"; "${marker(11)}";`), "prefix 2 times, not once"],
        ["the prefix once more without a number", bundle(`"${marker(11)}"; "${marker("")}";`), "prefix 2 times"],
        ["another number", bundle(`"${marker(12)}"`), 'release number "12", not the declared 11'],
        ["a number which only starts like the declared one", bundle(`"${marker(110)}"`), 'release number "110"'],
        ["a number with a leading zero", bundle(`"${marker("011")}"`), 'release number "011"'],
        ["a prefix without a number", bundle(`"${marker("")}"`), 'release number ""'],
    ])("refuses %s", (_, mainJs, message) => {
        const result = evaluateReleaseMarker({ mainJs, releaseNumber: 11 });

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(message);
        expect(() => enforceReleaseMarker({ mainJs, releaseNumber: 11 })).toThrow(
            new Error(`Release marker policy failed:\n- ${result.errors[0]}`)
        );
    });

    it.each([
        ["an undeclared number", { mainJs: bundle(marker(11)), releaseNumber: undefined }, "declared release number"],
        ["a declared number of zero", { mainJs: bundle(marker(0)), releaseNumber: 0 }, "declared release number"],
        ["a main.js which is not bytes", { mainJs: marker(11), releaseNumber: 11 }, "could not be read"],
    ])("fails closed for %s", (_, input, message) => {
        const result = evaluateReleaseMarker(input);

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain(message);
    });
});

describe("release tag", () => {
    const declared = { manifestVersion: "1.0.21", releaseNumber: 11 };

    it("accepts <manifest version>-security.<release number>", () => {
        const input = { tag: "1.0.21-security.11", ...declared };

        expect(evaluateReleaseTag(input)).toEqual({ ok: true, errors: [] });
        expect(() => enforceReleaseTag(input)).not.toThrow();
    });

    it.each([
        ["another release number", "1.0.21-security.12", "names release 12"],
        ["another version", "1.0.22-security.11", "names version 1.0.22"],
        ["a release number with a leading zero", "1.0.21-security.011", "not <version>-security.<number>"],
        ["a suffix after the number", "1.0.21-security.11-rc", "not <version>-security.<number>"],
        ["a prefix before the version", "v1.0.21-security.11", "not <version>-security.<number>"],
        ["no release number", "1.0.21", "not <version>-security.<number>"],
        ["a tag which is not a string", 11, "not <version>-security.<number>"],
    ])("refuses %s", (_, tag, message) => {
        const result = evaluateReleaseTag({ tag, ...declared });

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain(message);
        expect(() => enforceReleaseTag({ tag, ...declared })).toThrow("Release tag policy failed:");
    });

    it("reports a wrong version and a wrong number together", () => {
        expect(evaluateReleaseTag({ tag: "2.0.0-security.3", ...declared }).errors).toHaveLength(2);
    });
});

describe("the command-line gate's exit code", () => {
    const script = fileURLToPath(new URL("./verify-release-marker.mjs", import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd });

    it("exits zero when the built main.js carries the declared marker, and non-zero when it does not", () => {
        const good = join(cwd, "good-main.js");
        const bad = join(cwd, "bad-main.js");
        writeFileSync(good, `/* ${releaseMarkerText(securityRelease)} */\n`);
        writeFileSync(bad, "/* no marker here */\n");

        expect(run(["--main", good]).status).toBe(0);
        const failed = run(["--main", bad]);
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain("release marker");
    });

    it("exits non-zero on an unknown argument without reading anything", () => {
        expect(run(["--whatever", "x"]).status).toBe(1);
        expect(run([]).status).toBe(1);
    });
});

const cwd = mkdtempSync(join(tmpdir(), "marker-cli-"));
cpSync(fileURLToPath(new URL("../../security-release.json", import.meta.url)), join(cwd, "security-release.json"));
cpSync(fileURLToPath(new URL("../../manifest.json", import.meta.url)), join(cwd, "manifest.json"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
