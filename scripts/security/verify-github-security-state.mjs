import { pathToFileURL } from "node:url";

const REQUIRED_CODEQL_CATEGORIES = ["/language:actions", "/language:javascript-typescript"];

function requireArray(value, label, errors) {
    if (Array.isArray(value)) return value;
    errors.push(`${label} response was missing or malformed; the release gate fails closed.`);
    return [];
}

export function evaluateGitHubSecurityState(state) {
    const errors = [];
    const analyses = requireArray(state.analyses, "CodeQL analyses", errors);
    const codeScanningAlerts = requireArray(state.codeScanningAlerts, "Code scanning alerts", errors);
    const dependabotAlerts = requireArray(state.dependabotAlerts, "Dependabot alerts", errors);
    const secretScanningAlerts = requireArray(state.secretScanningAlerts, "Secret scanning alerts", errors);

    if (state.resolvedRefSha !== state.expectedSha) {
        errors.push(
            `Expected commit ${state.expectedSha} does not match ${state.ref ?? "the declared ref"} at ${state.resolvedRefSha ?? "<missing>"}.`
        );
    }

    const successfulCategories = new Set(
        analyses
            .filter((analysis) => analysis?.commit_sha === state.expectedSha && (analysis.error ?? "") === "")
            .map((analysis) => analysis.category)
    );
    for (const category of REQUIRED_CODEQL_CATEGORIES) {
        if (!successfulCategories.has(category)) {
            errors.push(`The exact release commit lacks a successful CodeQL analysis for ${category}.`);
        }
    }

    const alertGroups = [
        ["CodeQL", codeScanningAlerts],
        ["Dependabot", dependabotAlerts],
        ["secret scanning", secretScanningAlerts],
    ];
    for (const [label, alerts] of alertGroups) {
        if (alerts.length > 0) {
            errors.push(`${label} has ${alerts.length} open alert(s); resolve every alert before releasing.`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        counts: {
            codeScanning: codeScanningAlerts.length,
            dependabot: dependabotAlerts.length,
            secretScanning: secretScanningAlerts.length,
        },
    };
}

export function enforceGitHubSecurityState(state) {
    const result = evaluateGitHubSecurityState(state);
    if (!result.ok) {
        throw new Error(`GitHub zero-open-alert release policy failed:\n- ${result.errors.join("\n- ")}`);
    }
    return result;
}

// Stryker disable all: API transport and CLI plumbing are integration boundaries; mutate the policy decision above.
function nextPage(linkHeader) {
    if (!linkHeader) return undefined;
    for (const entry of linkHeader.split(",")) {
        const match = entry.match(/<([^>]+)>;\s*rel="([^"]+)"/u);
        if (match?.[2] === "next") return match[1];
    }
    return undefined;
}

async function requestJson(url, token, fetchImplementation) {
    const response = await fetchImplementation(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (!response.ok) {
        throw new Error(
            `GitHub security-state request failed closed: ${response.status} ${response.statusText} (${url})`
        );
    }
    return { body: await response.json(), next: nextPage(response.headers.get("link")) };
}

async function requestAll(initialUrl, token, fetchImplementation) {
    const items = [];
    let url = initialUrl;
    while (url) {
        const { body, next } = await requestJson(url, token, fetchImplementation);
        if (!Array.isArray(body)) throw new Error(`GitHub list response was malformed and failed closed (${url}).`);
        items.push(...body);
        url = next;
    }
    return items;
}

export async function collectGitHubSecurityState({
    repository,
    expectedSha,
    token,
    scope = "main",
    pullRequestNumber,
    apiUrl = "https://api.github.com",
    fetchImplementation = fetch,
}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
        throw new Error("GITHUB_REPOSITORY must identify one owner/repository pair.");
    }
    if (!/^[0-9a-f]{40}$/u.test(expectedSha ?? "")) {
        throw new Error("EXPECTED_SHA must be one full lowercase Git commit SHA.");
    }
    if (!token) throw new Error("GH_TOKEN is required to query the protected GitHub security state.");
    if (scope !== "main" && scope !== "pull-request") {
        throw new Error("SECURITY_SCOPE must be main or pull-request.");
    }
    if (scope === "pull-request" && !/^[1-9][0-9]*$/u.test(String(pullRequestNumber ?? ""))) {
        throw new Error("PULL_REQUEST_NUMBER must be a positive integer for pull-request scope.");
    }

    const repositoryUrl = `${apiUrl.replace(/\/$/u, "")}/repos/${repository}`;
    const ref = scope === "pull-request" ? `refs/pull/${pullRequestNumber}/merge` : "refs/heads/main";
    const encodedRef = encodeURIComponent(ref);
    const commitResponse = await requestJson(`${repositoryUrl}/commits/${encodedRef}`, token, fetchImplementation);
    const analysesUrl = `${repositoryUrl}/code-scanning/analyses?ref=${encodedRef}&tool_name=CodeQL&per_page=100`;
    const codeScanningSelector = scope === "pull-request" ? `pr=${pullRequestNumber}` : `ref=${encodedRef}`;
    const codeScanningUrl = `${repositoryUrl}/code-scanning/alerts?state=open&${codeScanningSelector}&per_page=100`;
    const dependabotUrl = `${repositoryUrl}/dependabot/alerts?state=open&per_page=100`;
    const secretScanningUrl = `${repositoryUrl}/secret-scanning/alerts?state=open&per_page=100`;
    const [analyses, codeScanningAlerts, dependabotAlerts, secretScanningAlerts] = await Promise.all([
        requestAll(analysesUrl, token, fetchImplementation),
        requestAll(codeScanningUrl, token, fetchImplementation),
        requestAll(dependabotUrl, token, fetchImplementation),
        requestAll(secretScanningUrl, token, fetchImplementation),
    ]);
    return {
        expectedSha,
        ref,
        resolvedRefSha: commitResponse.body?.sha,
        analyses,
        codeScanningAlerts,
        dependabotAlerts,
        secretScanningAlerts,
    };
}

export async function runGitHubSecurityStateGate(environment = process.env) {
    const state = await collectGitHubSecurityState({
        repository: environment.GITHUB_REPOSITORY,
        expectedSha: environment.EXPECTED_SHA,
        token: environment.GH_TOKEN,
        scope: environment.SECURITY_SCOPE,
        pullRequestNumber: environment.PULL_REQUEST_NUMBER,
        apiUrl: environment.GITHUB_API_URL,
    });
    const result = enforceGitHubSecurityState(state);
    console.log(
        `Open alerts: CodeQL=${result.counts.codeScanning} Dependabot=${result.counts.dependabot} secret-scanning=${result.counts.secretScanning}`
    );
    console.log(`GitHub zero-open-alert release policy passed for exact commit ${state.expectedSha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runGitHubSecurityStateGate().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
