const assert = process.getBuiltinModule("node:assert/strict");
const { test } = process.getBuiltinModule("node:test");
const { readFile } = process.getBuiltinModule("node:fs/promises");
import {
    isDependabotCandidate,
    isSameCandidate,
    enforceCandidateState,
    maintainDependabot,
} from "../scripts/security/dependabot-automerge.mjs";

const repository = "example/project";
const pr = () => ({
    number: 7,
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]", type: "Bot" },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: repository } },
    head: { ref: "dependabot/npm_and_yarn/example-2", sha: "a".repeat(40), repo: { full_name: repository } },
    merge_commit_sha: "c".repeat(40),
});
const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/example": { version: "2.0.0" } } };
const state = () => ({
    expectedSha: "c".repeat(40),
    resolvedRefSha: "c".repeat(40),
    analyses: ["actions", "javascript-typescript"].map((language) => ({
        commit_sha: "c".repeat(40),
        category: `/language:${language}`,
    })),
    codeScanningAlerts: [],
    dependabotAlerts: [],
    secretScanningAlerts: [],
});
const audit = { metadata: { vulnerabilities: { total: 0 } } };

test("accepts only an open same-repository Dependabot PR targeting main", () => {
    assert.equal(isDependabotCandidate(pr(), repository), true);
    for (const override of [
        { user: { login: "someone", type: "Bot" } },
        { user: { login: "dependabot[bot]", type: "User" } },
        { head: { ...pr().head, repo: { full_name: "other/project" } } },
        { base: { ...pr().base, repo: { full_name: "other/project" } } },
        { base: { ...pr().base, ref: "other" } },
        { state: "closed" },
        { draft: true },
        { head: { ...pr().head, ref: "maintenance" } },
        { merge_commit_sha: null },
    ]) {
        assert.equal(isDependabotCandidate({ ...pr(), ...override }, repository), false);
    }
});

test("rejects a changed head, base, or merge revision", () => {
    assert.equal(isSameCandidate(pr(), pr(), repository), true);
    for (const override of [
        { head: { ...pr().head, sha: "d".repeat(40) } },
        { base: { ...pr().base, sha: "d".repeat(40) } },
        { merge_commit_sha: "d".repeat(40) },
    ]) {
        assert.equal(isSameCandidate(pr(), { ...pr(), ...override }, repository), false);
    }
});

test("keeps the complete candidate security matrix mandatory", () => {
    assert.doesNotThrow(() => enforceCandidateState(lock, state(), audit));
    for (const override of [
        { secretScanningAlerts: null },
        { secretScanningAlerts: [{}] },
        { dependabotAlerts: null },
        { codeScanningAlerts: [{}] },
        { analyses: [] },
        { resolvedRefSha: "d".repeat(40) },
        {
            dependabotAlerts: [
                {
                    dependency: { package: { ecosystem: "npm", name: "example" }, manifest_path: "package-lock.json" },
                    security_vulnerability: { vulnerable_version_range: "<= 2.0.0" },
                },
            ],
        },
    ]) {
        assert.throws(() => enforceCandidateState(lock, { ...state(), ...override }, audit));
    }
    for (const bad of [null, {}, { metadata: { vulnerabilities: { total: 1 } } }])
        assert.throws(() => enforceCandidateState(lock, state(), bad));
});

async function exercise({ changed = false, mergeAccepted = true, insecure = false } = {}) {
    /** @type {Array<{path: string, options?: {method?: string, body?: Record<string, unknown>}}>} */
    const calls = [];
    let reads = 0;
    const result = await maintainDependabot({
        repository,
        log: () => {},
        collectState: async () => state(),
        auditLock: async () => (insecure ? {} : audit),
        request: async (
            /** @type {string} */ path,
            /** @type {{method?: string, body?: Record<string, unknown>}} */ options
        ) => {
            calls.push({ path, options });
            if (path.startsWith("pulls?")) return [{ number: 7 }];
            if (path === "pulls/7") {
                const candidate = pr();
                if (++reads > 1 && changed) candidate.head.sha = "d".repeat(40);
                return candidate;
            }
            if (path.startsWith("contents/"))
                return { encoding: "base64", content: Buffer.from(JSON.stringify(lock)).toString("base64") };
            if (path === "pulls/7/merge") {
                if (!mergeAccepted) throw new Error("Protected branch check has not passed");
                return { merged: true };
            }
            return null;
        },
    });
    return { calls, result };
}

test("publishes a candidate-only status and merges the exact checked head", async () => {
    const { calls, result } = await exercise();
    assert.equal(result.merged, 1);
    const status = calls.find((c) => c.path.startsWith("statuses/"));
    assert.match(String(status?.options?.body?.description), /^PR:/u);
    const merge = calls.find((c) => c.path.endsWith("/merge"));
    assert.deepEqual(merge?.options?.body, { sha: "a".repeat(40), merge_method: "squash" });
    assert.equal(calls.filter((c) => c.path.endsWith("/dispatches")).length, 2);
});

test("does not publish or merge a stale or insecure candidate", async () => {
    for (const configuration of [{ changed: true }, { insecure: true }]) {
        const { calls, result } = await exercise(configuration);
        assert.equal(result.merged, 0);
        assert.equal(
            calls.some((c) => c.options?.method),
            false
        );
    }
});

test("does not bypass a rejected protected merge or dispatch main CI for it", async () => {
    const { calls, result } = await exercise({ mergeAccepted: false });
    assert.equal(result.merged, 0);
    assert.equal(
        calls.some((c) => c.path.endsWith("/dispatches")),
        false
    );
});

test("privileged maintenance loads main and never executes PR code or consumes its artifacts", async () => {
    const workflow = await readFile(new URL("../.github/workflows/dependabot-automerge.yml", import.meta.url), "utf8");
    assert.match(workflow, /workflow_run:/u);
    assert.match(workflow, /environment: dependency-maintenance/u);
    assert.match(workflow, /ref: refs\/heads\/main/u);
    assert.doesNotMatch(workflow, /pull_request_target:|download-artifact|github\.event\.workflow_run\.head_sha/u);
    assert.match(workflow, /permission-secret-scanning-alerts: read/u);
    assert.match(workflow, /permission-vulnerability-alerts: read/u);
});
