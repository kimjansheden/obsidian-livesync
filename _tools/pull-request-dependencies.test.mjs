const assert = process.getBuiltinModule("node:assert/strict");
const { test } = process.getBuiltinModule("node:test");
import { evaluatePullRequestDependencies as evaluate } from "../scripts/security/verify-pull-request-dependencies.mjs";
import { evaluatePublishedZeroAlertStatus } from "../scripts/security/verify-published-zero-alert-status.mjs";
/** @param {Record<string, {version?: string, name?: string}>} packages */
const lock = (packages) => ({ lockfileVersion: 3, packages: { "": {}, ...packages } });
const alert = (range = ">= 8.0.0, <= 8.1.5") => ({
    dependency: { package: { ecosystem: "npm", name: "vite" }, manifest_path: "package-lock.json" },
    security_vulnerability: { vulnerable_version_range: range },
});
test("accepts patched versions and dependencies removed from the complete graph", () => {
    assert.equal(evaluate(lock({ "node_modules/vite": { version: "8.1.6" } }), [alert()]).ok, true);
    assert.equal(evaluate(lock({}), [alert()]).ok, true);
});
test("rejects vulnerable direct, nested, aliased and prerelease instances", () => {
    for (const packages of [
        { "node_modules/vite": { version: "8.1.5" } },
        { "node_modules/vite": { version: "8.1.6" }, "node_modules/a/node_modules/vite": { version: "8.1.0" } },
        { "node_modules/alias": { name: "vite", version: "8.1.0" } },
        { "node_modules/vite": { version: "8.1.5-rc.1" } },
    ])
        assert.equal(evaluate(lock(packages), [alert()]).ok, false);
});
test("does not confuse a similarly named dependency with the reported package", () => {
    assert.equal(evaluate(lock({ "node_modules/not-vite": { version: "8.1.0" } }), [alert()]).ok, true);
});
test("fails closed on missing or malformed API responses and lock graphs", () => {
    for (const invalid of [null, {}, { lockfileVersion: 3, packages: {} }])
        assert.equal(evaluate(invalid, []).ok, false);
    for (const invalid of [null, {}, [null], [alert("not-a-range")]])
        assert.equal(evaluate(lock({}), invalid).ok, false);
    assert.equal(evaluate(lock({ "node_modules/vite": {} }), [alert()]).ok, false);
});
test("fails closed on other manifests and ecosystems", () => {
    for (const override of [
        { manifest_path: "other/package-lock.json" },
        { package: { ecosystem: "pip", name: "vite" } },
    ]) {
        const a = alert();
        Object.assign(a.dependency, override);
        assert.equal(evaluate(lock({}), [a]).ok, false);
    }
});
test("a candidate attestation cannot satisfy the production release gate", () => {
    const now = Date.now();
    const result = evaluatePublishedZeroAlertStatus({
        statuses: [
            {
                context: "Zero open security alerts",
                state: "success",
                description: "PR: CodeQL=0 affected lock versions=0 secrets=0",
                creator: { login: "owner" },
                updated_at: new Date(now).toISOString(),
            },
        ],
        expectedActor: "owner",
        now,
        maxAgeMilliseconds: 60_000,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /complete zero-alert matrix/);
});
