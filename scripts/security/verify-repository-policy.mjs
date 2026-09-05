import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, posix } from "node:path";

const ROOT_DIRECTORIES = new Set([
    ".github",
    "_tools",
    "docker",
    "docs",
    "images",
    "instruction_images",
    "scripts",
    "src",
    "test",
    "utils",
    "utilsdeno",
]);

const ROOT_FILES = new Set([
    ".dockerignore",
    ".eslintrc",
    ".gitattributes",
    ".gitignore",
    ".prettierignore",
    ".prettierrc.mjs",
    ".test.env",
    "AGENTS.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "README_cn.md",
    "README_es.md",
    "README_ja.md",
    "SECURITY.md",
    "aggregator.html",
    "devs.md",
    "docker-compose.traefik.yml",
    "esbuild.config.mjs",
    "eslint.community.config.mjs",
    "eslint.config.common.mjs",
    "eslint.config.mjs",
    "example.env",
    "manifest.json",
    "package-lock.json",
    "package.json",
    "pouchdb-browser.js",
    "setup-flyio-on-the-fly-v2.ipynb",
    "security-release.json",
    "styles.css",
    "stryker.config.json",
    "terser.config.mjs",
    "terser_vite.config.ts",
    "tsconfig.json",
    "update-workspaces.mjs",
    "updates.md",
    "updates_old.md",
    "version-bump.mjs",
    "versions.json",
    "vite.config.ts",
    "vitest.config.common.ts",
    "vitest.config.e2e-runner.ts",
    "vitest.config.integration.ts",
    "vitest.config.security-mutation.ts",
    "vitest.config.unit.ts",
]);

const ALLOWED_ENV_FIXTURES = new Set([
    ".test.env",
    "example.env",
    "src/apps/cli/.test.env",
    "src/apps/cli/testdeno/.test.env",
]);
const TEXT_EXTENSIONS = new Set([
    "",
    ".cjs",
    ".css",
    ".env",
    ".html",
    ".ini",
    ".ipynb",
    ".js",
    ".json",
    ".jsonc",
    ".md",
    ".mjs",
    ".ps1",
    ".py",
    ".service",
    ".sh",
    ".svelte",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
]);

const SECRET_PATTERNS = [
    ["private key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{20,}\r?\n)+/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
    ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
];
const CREDENTIALED_URL = /https?:\/\/[^\s/@:]+:[^\s/@]+@([A-Za-z0-9.-]+)/g;
const EXAMPLE_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "example.com",
    "example.net",
    "example.org",
    "example.invalid",
]);

const failures = [];
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
})
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(path));

for (const rawPath of tracked) {
    const path = rawPath.replaceAll("\\", "/");
    const [root] = path.split("/");
    if (path.includes("/") ? !ROOT_DIRECTORIES.has(root) : !ROOT_FILES.has(path))
        failures.push(`unexpected tracked path: ${path}`);
    if (
        (posix.basename(path) === ".env" || posix.basename(path).startsWith(".env.")) &&
        !path.endsWith(".env.example") &&
        !ALLOWED_ENV_FIXTURES.has(path)
    ) {
        failures.push(`environment file is not an approved synthetic fixture: ${path}`);
    }
    if (/\.(?:key|p12|pfx|pem|kdbx|sqlite3?|zip)$/i.test(path))
        failures.push(`forbidden credential/support artifact type: ${path}`);
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()) && extname(path) !== "") continue;

    const content = readFileSync(path, "utf8");
    if (/\b[A-Za-z]:\\(?:Users|Dropbox)\\/i.test(content)) failures.push(`absolute private Windows path: ${path}`);
    for (const [label, pattern] of SECRET_PATTERNS)
        if (pattern.test(content)) failures.push(`${label} marker: ${path}`);
    for (const match of content.matchAll(CREDENTIALED_URL)) {
        const host = match[1].toLowerCase();
        if (!EXAMPLE_HOSTS.has(host) && !host.endsWith(".example")) failures.push(`credentialed URL marker: ${path}`);
    }
}

for (const workflow of tracked.filter((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/i.test(path))) {
    const content = readFileSync(workflow, "utf8");
    if (/pull_request_target\s*:/i.test(content)) failures.push(`pull_request_target is forbidden: ${workflow}`);
    if (/\bself-hosted\b/i.test(content)) failures.push(`self-hosted runner is forbidden: ${workflow}`);
    if (/\bsecrets\./i.test(content)) failures.push(`repository secret reference is forbidden: ${workflow}`);
    for (const match of content.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/g)) {
        if (!/^[0-9a-f]{40}$/.test(match[2]))
            failures.push(`action is not pinned to a full commit: ${workflow}: ${match[1]}@${match[2]}`);
    }
    if (!/^permissions:/m.test(content)) failures.push(`top-level permissions are missing: ${workflow}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const securityRelease = JSON.parse(readFileSync("security-release.json", "utf8"));
const commonlibRelease = JSON.parse(readFileSync("docs/security/commonlib-release.json", "utf8"));
const commonlibPackage = packageLock.packages?.["node_modules/@vrtmrz/livesync-commonlib"];
const expectedCommonlibPackageUrl = `${commonlibRelease.repository}/releases/download/${commonlibRelease.tag}/vrtmrz-livesync-commonlib-${commonlibRelease.tag}.tgz`;
const expectedCommonlibSourceReceiptUrl = `${commonlibRelease.repository}/releases/download/${commonlibRelease.tag}/source-receipt.json`;

if (securityRelease.upstreamRepository !== "https://github.com/vrtmrz/obsidian-livesync.git") {
    failures.push("security-release.json must identify the official LiveSync upstream repository");
}
if (!/^[0-9a-f]{40}$/u.test(securityRelease.upstreamBase ?? "")) {
    failures.push("security-release.json must pin one full upstream base commit");
}
try {
    execFileSync("git", ["merge-base", "--is-ancestor", securityRelease.upstreamBase, "HEAD"], {
        stdio: "ignore",
    });
} catch {
    failures.push("the declared LiveSync upstream base is not an ancestor of HEAD");
}

for (const field of ["upstreamBase", "forkCommit"]) {
    if (!/^[0-9a-f]{40}$/u.test(commonlibRelease[field] ?? "")) {
        failures.push(`Commonlib release field ${field} must be a full commit SHA`);
    }
}
for (const field of ["packageSha256", "packageLockSha256", "sourceReceiptSha256"]) {
    if (!/^[0-9a-f]{64}$/u.test(commonlibRelease[field] ?? "")) {
        failures.push(`Commonlib release field ${field} must be a SHA-256 digest`);
    }
}
if (commonlibRelease.repositorySlug !== "kimjansheden/livesync-commonlib") {
    failures.push("Commonlib release receipt must identify the public security fork");
}
if (commonlibRelease.repository !== `https://github.com/${commonlibRelease.repositorySlug}`) {
    failures.push("Commonlib repository URL and slug do not agree");
}
if (commonlibRelease.upstreamRepository !== "https://github.com/vrtmrz/livesync-commonlib.git") {
    failures.push("Commonlib release receipt must identify the official upstream repository");
}
if (!/^0\.1\.19-security\.[0-9]+$/u.test(commonlibRelease.tag ?? "")) {
    failures.push("Commonlib release receipt must select an immutable 0.1.19 security tag");
}
if (commonlibRelease.releaseUrl !== `${commonlibRelease.repository}/releases/tag/${commonlibRelease.tag}`) {
    failures.push("Commonlib release URL does not match its repository and tag");
}
if (commonlibRelease.packageUrl !== expectedCommonlibPackageUrl) {
    failures.push("Commonlib package URL does not match its repository and tag");
}
if (commonlibRelease.sourceReceiptUrl !== expectedCommonlibSourceReceiptUrl) {
    failures.push("Commonlib source-receipt URL does not match its repository and tag");
}
if (commonlibRelease.signerWorkflow !== `${commonlibRelease.repositorySlug}/.github/workflows/release.yml`) {
    failures.push("Commonlib signer workflow does not match its public repository");
}
if (!/^\d+$/u.test(commonlibRelease.releaseWorkflowRun ?? "")) {
    failures.push("Commonlib release workflow run must be an exact numeric identity");
}
if (packageJson.dependencies?.["@vrtmrz/livesync-commonlib"] !== commonlibRelease.packageUrl) {
    failures.push("package.json must consume the exact attested Commonlib package URL");
}
if (packageLock.packages?.[""]?.dependencies?.["@vrtmrz/livesync-commonlib"] !== commonlibRelease.packageUrl) {
    failures.push("package-lock.json root dependency must consume the exact Commonlib package URL");
}
if (commonlibPackage?.version !== commonlibRelease.tag) {
    failures.push("the locked Commonlib version does not match the release receipt tag");
}
if (commonlibPackage?.resolved !== commonlibRelease.packageUrl) {
    failures.push("the locked Commonlib URL does not match the release receipt");
}
if (commonlibPackage?.integrity !== commonlibRelease.packageIntegrity) {
    failures.push("the locked Commonlib integrity does not match the release receipt");
}
if (packageJson.scripts?.["test:security-state-faults"] !== "vitest run --config vitest.config.security-mutation.ts") {
    failures.push(
        "security-state fault script is missing; restore test:security-state-faults so the zero-alert gate's negative paths run"
    );
}
if (packageJson.scripts?.["test:security-state-mutations"] !== "stryker run") {
    failures.push(
        "security-state mutation script is missing; restore test:security-state-mutations so production gate mutants block CI"
    );
}
if (packageJson.scripts?.["test:release-workflow"] !== "node --test _tools/security-release-workflow.test.mjs") {
    failures.push("release workflow contract tests must remain available through test:release-workflow");
}

const strykerConfig = JSON.parse(readFileSync("stryker.config.json", "utf8"));
if (
    JSON.stringify(strykerConfig.mutate) !==
    JSON.stringify([
        "scripts/security/verify-github-security-state.mjs",
        "scripts/security/verify-published-zero-alert-status.mjs",
    ])
) {
    failures.push(
        "Stryker must mutate both production GitHub security-state gates and no substitute test implementation"
    );
}
if (
    strykerConfig.thresholds?.high !== 100 ||
    strykerConfig.thresholds?.low !== 100 ||
    strykerConfig.thresholds?.break !== 100
) {
    failures.push("Stryker thresholds must remain high=100, low=100, break=100 so any relevant survivor blocks CI");
}
const forbiddenMutationExclusions = new Set([
    "BooleanLiteral",
    "ConditionalExpression",
    "EqualityOperator",
    "LogicalOperator",
]);
for (const mutation of strykerConfig.mutator?.excludedMutations ?? []) {
    if (forbiddenMutationExclusions.has(mutation)) {
        failures.push(`Stryker may not exclude security-decision mutator ${mutation}; remove that exclusion`);
    }
}

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const securityWorkflow = readFileSync(".github/workflows/security-ci.yml", "utf8");
const codeqlWorkflow = readFileSync(".github/workflows/codeql.yml", "utf8");
for (const [label, workflow] of [
    ["release", releaseWorkflow],
    ["security CI", securityWorkflow],
]) {
    if (!workflow.includes("npm run test:security-state-mutations")) {
        failures.push(`${label} workflow must run test:security-state-mutations before it can be green`);
    }
    if (!workflow.includes("npm run test:release-workflow")) {
        failures.push(`${label} workflow must run test:release-workflow before it can be green`);
    }
    if (!workflow.includes("node scripts/security/verify-commonlib-source-receipt.mjs")) {
        failures.push(`${label} workflow must compare every downloaded Commonlib source-receipt identity field`);
    }
}
if (!codeqlWorkflow.includes("name: Zero open CodeQL alerts")) {
    failures.push("CodeQL workflow must expose the Zero open CodeQL alerts status after all analyses");
}
if (!codeqlWorkflow.includes("node scripts/security/verify-github-security-state.mjs")) {
    failures.push("CodeQL workflow must run the production CodeQL zero-alert gate after analysis");
}
if (!codeqlWorkflow.includes("SECURITY_COMPONENTS: codeql")) {
    failures.push("CodeQL workflow must explicitly limit its token-compatible query to CodeQL alerts");
}
if (!codeqlWorkflow.includes("name: Zero open security alerts")) {
    failures.push("CodeQL workflow must expose the complete Zero open security alerts gate after CodeQL");
}
if (!codeqlWorkflow.includes("SECURITY_COMPONENTS: all")) {
    failures.push("CodeQL workflow must query every declared alert class before the complete gate can be green");
}
if (!releaseWorkflow.includes("verify-published-zero-alert-status.mjs")) {
    failures.push("release workflow must verify the externally attested zero-open-security-alert status");
}

const historySearch = [
    ["GitHub token", "gh[pousr]_[A-Za-z0-9]{20,}"],
    ["AWS access key", "(AKIA|ASIA)[0-9A-Z]{16}"],
];

const forkRawContentBase = ["https://raw.githubusercontent.com", "kimjansheden", "obsidian-livesync"].join("/");
const movingForkExecutionUrls = ["main", "master"].map((branch) => `${forkRawContentBase}/${branch}/`);
for (const file of tracked) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase()) && extname(file) !== "") continue;
    const content = readFileSync(file, "utf8");
    if (movingForkExecutionUrls.some((url) => content.includes(url))) {
        failures.push(`moving fork execution URL is forbidden; pin an immutable reviewed tag or commit: ${file}`);
    }
}

for (const [label, gitPattern] of historySearch) {
    try {
        const matches = execFileSync("git", ["log", "--all", "--format=%H", "-G", gitPattern, "--", ":!*.lock"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (matches) failures.push(`${label} appears in Git history at ${matches.split(/\r?\n/)[0]}`);
    } catch (error) {
        failures.push(`history scan failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

if (failures.length > 0) {
    console.error(`Repository security policy failed with ${failures.length} finding(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log(
        `Repository security policy passed for ${tracked.length} current files and provider-token patterns in complete Git history.`
    );
}
