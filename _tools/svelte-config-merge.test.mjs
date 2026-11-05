const assert = process.getBuiltinModule("node:assert/strict");
const { test } = process.getBuiltinModule("node:test");
import mergeConfig from "./svelte-config-merge/index.mjs";

const options = {
    /** @param {ReadonlyArray<unknown>} target @param {ReadonlyArray<unknown>} source */
    arrayMerge: (target, source) => source ?? target,
};

test("Svelte options merge nested defaults, replace arrays, and retain callbacks", () => {
    const preprocess = () => "synthetic";
    const defaults = { compilerOptions: { dev: true, css: "external" }, include: ["default"], preprocess };
    const inline = { compilerOptions: { dev: false }, include: ["custom"] };
    assert.deepEqual(mergeConfig(defaults, inline, options), {
        compilerOptions: { dev: false, css: "external" },
        include: ["custom"],
        preprocess,
    });
    assert.deepEqual(defaults.include, ["default"]);
    assert.equal(defaults.compilerOptions.dev, true);
});

test("explicit undefined and null retain their configuration override meaning", () => {
    assert.deepEqual(mergeConfig({ first: 1, second: 2 }, { first: undefined, second: null }, options), {
        first: undefined,
        second: null,
    });
});

for (const target of [Object.create(null), { session: null }, JSON.parse('{"__proto__":{"defaultFlag":true}}')]) {
    test(`configuration merging does not inherit injected properties (${JSON.stringify(target)})`, () => {
        /** @type {unknown} */
        const source = JSON.parse('{"__proto__":{"injected":true},"session":{"__proto__":{"injected":true}}}');
        const result = /** @type {Record<string, unknown>} */ (mergeConfig(target, source, options));
        assert.equal(result.injected, undefined);
        const session = /** @type {Record<string, unknown>} */ (result.session);
        assert.equal(session.injected, undefined);
        assert.equal({}.injected, undefined);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(Object.getPrototypeOf(session), Object.prototype);
    });
}

test("unsupported configuration merge options fail explicitly", () => {
    assert.throws(() => mergeConfig({}, {}, { clone: false }), /Unsupported/);
    assert.throws(() => mergeConfig({}, {}), /array merge function/);
});

test("the installed Svelte Vite plug-in resolves the audited configuration merge adapter", async () => {
    const { default: installed } = await import("deepmerge");
    assert.equal(installed, mergeConfig);
    const { svelte } = await import("@sveltejs/vite-plugin-svelte");
    const plugins = svelte();
    const main = plugins.find((plugin) => plugin.name === "vite-plugin-svelte:config");
    assert.ok(main?.config);
    const config = typeof main.config === "function" ? main.config : main.config.handler;
    const result = await config.call(
        {},
        { root: process.cwd(), logLevel: "silent" },
        { command: "build", mode: "production" }
    );
    assert.ok(result.resolve);
});
