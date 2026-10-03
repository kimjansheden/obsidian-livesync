import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   bomFormat: "CycloneDX",
 *   specVersion: string,
 *   serialNumber?: string,
 *   metadata: { timestamp?: string, component: Record<string, unknown> },
 *   components: unknown[],
 *   [key: string]: unknown
 * }} CycloneDxSbom
 */

/**
 * @typedef {{ packages?: Record<string, { link?: boolean, name?: string, resolved?: string, version?: string }> }} PackageLock
 */

/** @param {CycloneDxSbom} sbom @param {PackageLock} packageLock */
function restoreWorkspaceNames(sbom, packageLock) {
    const packages = packageLock.packages ?? {};
    for (const [linkPath, link] of Object.entries(packages)) {
        if (!link.link || !link.resolved || !linkPath.startsWith("node_modules/")) continue;
        const workspace = packages[link.resolved];
        if (!workspace?.version) continue;

        const declaredName = workspace.name ?? linkPath.slice("node_modules/".length);
        const component = sbom.components.find((candidate) => {
            if (!candidate || typeof candidate !== "object") return false;
            return candidate["bom-ref"] === `${declaredName}@${workspace.version}`;
        });
        if (component && typeof component === "object") component.name = declaredName;
    }
}

/** @param {unknown} source @param {PackageLock} [packageLock] @returns {CycloneDxSbom} */
export function normaliseCycloneDxSbom(source, packageLock = {}) {
    const candidate = /** @type {Partial<CycloneDxSbom>} */ (source);
    if (
        candidate?.bomFormat !== "CycloneDX" ||
        !Array.isArray(candidate.components) ||
        !candidate.metadata?.component
    ) {
        throw new Error("npm returned malformed CycloneDX output.");
    }

    const sbom = structuredClone(/** @type {CycloneDxSbom} */ (candidate));
    restoreWorkspaceNames(sbom, packageLock);
    delete sbom.serialNumber;
    delete sbom.metadata.timestamp;
    return sbom;
}

export async function generateSbom(outputPath, environment = process.env) {
    const npmExecPath = environment.npm_execpath;
    if (!npmExecPath) {
        throw new Error("npm_execpath is required; run this generator through npm run sbom.");
    }

    const result = spawnSync(
        process.execPath,
        [npmExecPath, "sbom", "--sbom-format", "cyclonedx", "--package-lock-only", "--sbom-type", "library"],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    if (result.status !== 0) {
        throw new Error(`npm sbom failed: ${(result.stderr || "unknown error").trim()}`);
    }

    const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
    const sbom = normaliseCycloneDxSbom(JSON.parse(result.stdout), packageLock);
    await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outputPath = process.argv[2];
    if (!outputPath || process.argv.length !== 3) {
        console.error("Usage: npm run sbom -- <output-file>");
        process.exitCode = 1;
    } else {
        generateSbom(outputPath).catch((error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        });
    }
}
