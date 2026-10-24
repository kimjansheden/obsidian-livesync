import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { collectGitHubSecurityState, enforceGitHubCodeQLState } from "./verify-github-security-state.mjs";
import { evaluatePullRequestDependencies } from "./verify-pull-request-dependencies.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const number = process.env.PULL_REQUEST_NUMBER;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !/^[1-9][0-9]*$/u.test(number ?? ""))
    throw new Error("Declare exactly one repository and pull request.");
const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
async function request(path, body) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub request failed closed: ${response.status}.`);
    return response.json();
}
const pr = await request(`pulls/${number}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (pr.state !== "open" || pr.head?.sha !== head || pr.base?.ref !== "main" || pr.head?.repo?.full_name !== repository)
    throw new Error("The checkout must be the exact open, same-repository PR head targeting main.");
const expectedLock = execFileSync("git", ["show", `${head}:package-lock.json`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
});
if (readFileSync("package-lock.json", "utf8").replaceAll("\r\n", "\n") !== expectedLock.replaceAll("\r\n", "\n"))
    throw new Error("The working lock graph differs from the reviewed commit.");
const state = await collectGitHubSecurityState({
    repository,
    expectedSha: pr.merge_commit_sha,
    token,
    scope: "pull-request",
    pullRequestNumber: number,
});
enforceGitHubCodeQLState(state);
if (!Array.isArray(state.secretScanningAlerts) || state.secretScanningAlerts.length !== 0)
    throw new Error("Resolve all secret scanning alerts before merging.");
const result = evaluatePullRequestDependencies(JSON.parse(expectedLock), state.dependabotAlerts);
if (!result.ok) throw new Error(result.errors.join("\n"));
let auditText;
try {
    auditText =
        process.platform === "win32"
            ? execFileSync("cmd.exe", ["/d", "/s", "/c", "npm audit --json"], {
                  encoding: "utf8",
                  maxBuffer: 16 * 1024 * 1024,
              })
            : execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
} catch {
    throw new Error("The complete candidate dependency audit failed closed.");
}
const audit = JSON.parse(auditText);
if (audit.error || audit.metadata?.vulnerabilities?.total !== 0) throw new Error("Candidate npm audit is not zero.");
const refreshed = await request(`pulls/${number}`);
if (refreshed.head?.sha !== head || refreshed.merge_commit_sha !== state.expectedSha || refreshed.state !== "open")
    throw new Error("The PR changed while its security state was being checked.");
await request(`statuses/${head}`, {
    state: "success",
    context: "Zero open security alerts",
    description: "PR: CodeQL=0 affected lock versions=0 secrets=0",
    target_url: `https://github.com/${repository}/pull/${number}/checks`,
});
console.log(
    `Candidate security state verified for ${head}; ${state.dependabotAlerts.length} default-branch alerts checked against its lock graph. Release attestation remains separate.`
);
