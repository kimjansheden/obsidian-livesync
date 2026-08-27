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
    "styles.css",
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

const historySearch = [
    ["GitHub token", "gh[pousr]_[A-Za-z0-9]{20,}"],
    ["AWS access key", "(AKIA|ASIA)[0-9A-Z]{16}"],
];
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
