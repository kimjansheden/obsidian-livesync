import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectGitHubSecurityState, enforceGitHubCodeQLState } from "./verify-github-security-state.mjs";
import { evaluatePullRequestDependencies } from "./verify-pull-request-dependencies.mjs";

export function isDependabotCandidate(pr, repository) {
    return (
        pr?.state === "open" &&
        pr.draft === false &&
        pr.user?.login === "dependabot[bot]" &&
        pr.user?.type === "Bot" &&
        pr.base?.ref === "main" &&
        pr.base?.repo?.full_name === repository &&
        pr.head?.repo?.full_name === repository &&
        /^dependabot\//u.test(pr.head?.ref ?? "") &&
        /^[0-9a-f]{40}$/u.test(pr.head?.sha ?? "") &&
        /^[0-9a-f]{40}$/u.test(pr.merge_commit_sha ?? "")
    );
}

export function isSameCandidate(before, after, repository) {
    return (
        isDependabotCandidate(after, repository) &&
        before.head.sha === after.head.sha &&
        before.base.sha === after.base.sha &&
        before.merge_commit_sha === after.merge_commit_sha
    );
}

export function enforceCandidateState(lock, state, audit) {
    enforceGitHubCodeQLState(state);
    if (!Array.isArray(state.secretScanningAlerts) || state.secretScanningAlerts.length !== 0)
        throw new Error("Repository secret scanning must have zero open alerts.");
    const dependencies = evaluatePullRequestDependencies(lock, state.dependabotAlerts);
    if (!dependencies.ok) throw new Error(dependencies.errors.join("\n"));
    if (audit?.error || audit?.metadata?.vulnerabilities?.total !== 0)
        throw new Error("The complete candidate npm audit must have zero vulnerabilities.");
}

export async function maintainDependabot({ repository, request, collectState, auditLock, log = console.log }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) throw new Error("Invalid repository.");
    let merged = 0;
    for (let page = 1; ; page++) {
        const prs = await request(`pulls?state=open&base=main&per_page=100&page=${page}`);
        if (!Array.isArray(prs)) throw new Error("Malformed pull request list.");
        for (const summary of prs) {
            const pr = await request(`pulls/${summary.number}`);
            if (!isDependabotCandidate(pr, repository)) continue;
            const head = pr.head.sha;
            try {
                const lockResponse = await request(`contents/package-lock.json?ref=${head}`);
                if (lockResponse?.encoding !== "base64" || typeof lockResponse.content !== "string")
                    throw new Error("The exact candidate lock graph is unavailable.");
                const lockText = Buffer.from(lockResponse.content, "base64").toString("utf8");
                const lock = JSON.parse(lockText);
                const state = await collectState(pr);
                enforceCandidateState(lock, state, await auditLock(lockText));
                if (!isSameCandidate(pr, await request(`pulls/${pr.number}`), repository))
                    throw new Error("The candidate changed during verification.");
                await request(`statuses/${head}`, {
                    method: "POST",
                    body: {
                        state: "success",
                        context: "Zero open security alerts",
                        description: "PR: CodeQL=0 affected lock versions=0 secrets=0",
                        target_url: `https://github.com/${repository}/pull/${pr.number}/checks`,
                    },
                });
                // GitHub enforces every protected-branch check and the expected head atomically.
                const result = await request(`pulls/${pr.number}/merge`, {
                    method: "PUT",
                    body: { sha: head, merge_method: "squash" },
                });
                if (result?.merged !== true) throw new Error("GitHub has not accepted the protected merge.");
                merged++;
                log(`Dependabot PR ${pr.number} merged after candidate and protected-branch checks.`);
            } catch {
                // A later CI completion or scheduled pass retries candidates that are not ready.
                log(`Dependabot PR ${pr.number} remains unmerged; its checks are not complete or did not pass.`);
            }
        }
        if (prs.length < 100) break;
    }
    if (merged) {
        // A merge made with GITHUB_TOKEN does not generate ordinary push workflow runs.
        for (const workflow of ["security-ci.yml", "codeql.yml"])
            await request(`actions/workflows/${workflow}/dispatches`, { method: "POST", body: { ref: "main" } });
    }
    return { merged };
}

async function auditLock(lockText) {
    const directory = await mkdtemp(join(tmpdir(), "dependabot-audit-"));
    try {
        const lock = JSON.parse(lockText);
        await writeFile(join(directory, "package-lock.json"), lockText);
        await writeFile(join(directory, "package.json"), JSON.stringify({ ...lock.packages[""], private: true }));
        // The candidate is data only. No dependency, lifecycle script, or PR configuration is executed.
        const environment = {
            PATH: process.env.PATH,
            ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
            HOME: directory,
            npm_config_cache: join(directory, "cache"),
            npm_config_userconfig: join(directory, ".npmrc"),
        };
        const auditArguments = ["audit", "--json", "--ignore-scripts", "--registry=https://registry.npmjs.org"];
        const output = execFileSync(
            process.platform === "win32" ? "cmd.exe" : "npm",
            process.platform === "win32" ? ["/d", "/s", "/c", `npm ${auditArguments.join(" ")}`] : auditArguments,
            { cwd: directory, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
        );
        return JSON.parse(output);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN;
    const readToken = process.env.SECURITY_READ_TOKEN;
    if (!token || !readToken) throw new Error("Both the workflow token and scoped security reader are required.");
    const request = async (path, options = {}) => {
        const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
            method: options.method ?? "GET",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        if (!response.ok) throw new Error(`GitHub request failed closed (${response.status}).`);
        return response.status === 204 ? null : response.json();
    };
    const result = await maintainDependabot({
        repository,
        request,
        collectState: (pr) =>
            collectGitHubSecurityState({
                repository,
                expectedSha: pr.merge_commit_sha,
                token: readToken,
                scope: "pull-request",
                pullRequestNumber: String(pr.number),
            }),
        auditLock,
    });
    console.log(`Protected Dependabot merges: ${result.merged}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(() => {
        console.error(
            "Dependabot maintenance failed closed. Check the security reader and GitHub workflow permissions."
        );
        process.exitCode = 1;
    });
