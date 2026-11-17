const assert = process.getBuiltinModule("node:assert/strict");
const { test } = process.getBuiltinModule("node:test");
const { createRequire } = process.getBuiltinModule("node:module");
const { readFileSync } = process.getBuiltinModule("node:fs");
const { createHash } = process.getBuiltinModule("node:crypto");
const { spawnSync } = process.getBuiltinModule("node:child_process");
const require = createRequire(import.meta.url);
/** @typedef {{isMatch: (input: string, glob: string) => boolean}} Matcher */
/** @type {unknown} */
const rawMatcher = require("./picomatch/index.js");
const match = /** @type {Matcher} */ (rawMatcher);

/** @param {URL} path @returns {unknown} */
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

test("repeated wildcard extglobs cannot cause unbounded backtracking", () => {
    const script = `const p=require(${JSON.stringify(require.resolve("./picomatch/index.js"))});
        for(const pattern of ['+(*)','+(*a)','*(*a)','+(*a|b)','+(a*b)','+(*(a))','+("x"*a)','+([[]*a)','+(["x]*a)','+([*a)']) {
            for(const options of [{},{maxExtglobRecursion:false},{capture:true}]) {
                for(const input of ['a'.repeat(160)+'!', '[a'.repeat(80)+'!']) {
                    if(p.makeRe(pattern+'b',options).test(input)) process.exit(2);
                }
            }
        }`;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 3000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr?.toString());
});

test("ordinary paths, fixed repetition, escaped stars, and character classes retain matching", () => {
    for (const [pattern, path] of [
        ["**/*.unit.spec.ts", "src/feature/example.unit.spec.ts"],
        ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "src/example.test.ts"],
        ["+(ab)", "abab"],
        ["*(ab)", "ababab"],
        ["+(*(a)|*(b))", "abba"],
        ["+([*])", "***"],
        [String.raw`+(\*)`, "***"],
        ['+("*")', "***"],
        ["+(a?)", "abab"],
    ]) {
        assert.equal(match.isMatch(path, pattern), true, pattern);
    }
    assert.equal(match.isMatch("src/example.txt", "**/*.ts"), false);
    assert.equal(match.isMatch("+(*)", "+(*)"), true);
    /** @type {unknown} */
    const rawPosix = require("./picomatch/posix.js");
    const posix = /** @type {Matcher} */ (rawPosix);
    assert.equal(posix.isMatch("src/example.ts", "**/*.ts"), true);
});

test("vendored source retains its recorded upstream distribution except for the declared patches", () => {
    const receipt = /** @type {{upstreamFiles: Record<string, string>}} */ (
        readJson(new URL("./picomatch/upstream.json", import.meta.url))
    );
    for (const [path, digest] of Object.entries(receipt.upstreamFiles)) {
        if (path === "lib/parse.js" || path === "lib/utils.js") continue;
        assert.equal(
            createHash("sha256")
                .update(readFileSync(new URL("./picomatch/" + path, import.meta.url)))
                .digest("hex"),
            digest,
            path
        );
    }
    const patched = readFileSync(new URL("./picomatch/lib/parse.js", import.meta.url), "utf8");
    const original = patched
        .replace(/const hasUnboundedWildcard = body => \{[\s\S]+?\n\};\n\n/u, "")
        .replace("  // Repeating an unbounded wildcard nests quantifiers even with a single branch.\n", "")
        .replace(/return \{ risky: hasUnboundedWildcard\(body\) \};/gu, "return { risky: false };");
    assert.equal(createHash("sha256").update(original).digest("hex"), receipt.upstreamFiles["lib/parse.js"]);
    const patchedUtils = readFileSync(new URL("./picomatch/lib/utils.js", import.meta.url), "utf8");
    const originalUtils = patchedUtils.replace(
        /exports.removeBackslashes = str => \{[\s\S]*?\n\};/u,
        "exports.removeBackslashes = str => {\n  return str.replace(REGEX_REMOVE_BACKSLASH, match => {\n    return match === '\\\\' ? '' : match;\n  });\n};"
    );
    assert.equal(createHash("sha256").update(originalUtils).digest("hex"), receipt.upstreamFiles["lib/utils.js"]);
});

test("backslash removal preserves the upstream matching contract with linear scans", () => {
    /** @type {unknown} */
    const loaded = require("./picomatch/lib/utils.js");
    const utils = /** @type {{removeBackslashes: (value: string) => string}} */ (loaded);
    const oracle = (/** @type {string} */ value) =>
        value.replace(/(?:\[.*?[^\\]\]|\\(?=.))/g, (match) => (match === "\\" ? "" : match));
    const alphabet = ["[", "]", "\\", "a", "\n", "\r", "\u2028", "\u2029"];
    let seed = 17;
    for (let n = 0; n < 5000; n++) {
        let value = "";
        for (let i = 0; i < n % 24; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            value += alphabet[(seed >>> 16) % alphabet.length];
        }
        assert.equal(utils.removeBackslashes(value), oracle(value), JSON.stringify(value));
    }
    const script = `require(${JSON.stringify(require.resolve("./picomatch/lib/utils.js"))}).removeBackslashes('['.repeat(262144))`;
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 3000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
});

test("the complete installed lock graph uses the patched package for picomatch consumers", () => {
    assert.equal(require("picomatch"), match);
    const lock = /** @type {{packages: Record<string, {resolved?: string, name?: string}>}} */ (
        readJson(new URL("../package-lock.json", import.meta.url))
    );
    assert.ok(Object.keys(lock.packages).some((path) => path.endsWith("node_modules/picomatch")));
    for (const [path, info] of Object.entries(lock.packages)) {
        if (path.endsWith("node_modules/picomatch")) assert.equal(info.resolved, "_tools/picomatch", path);
    }
    assert.equal(lock.packages["_tools/picomatch"].name, "@livesync/picomatch");
});
