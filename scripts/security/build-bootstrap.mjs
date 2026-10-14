import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { enforceReleaseMarker, readReleaseNumber, releaseMarkerText } from "./verify-release-marker.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Build the local baseline and permanent loader from the same verified payload build. No signing key is used. */
export async function buildBootstrap() {
    const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
    const security = JSON.parse(await readFile("security-release.json", "utf8"));
    const files = [];
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
        const bytes = await readFile(name);
        files.push({ name, size: bytes.length, sha256: hash(bytes), content: bytes.toString("base64") });
    }
    enforceReleaseMarker({
        mainJs: Buffer.from(files[0].content, "base64"),
        releaseNumber: readReleaseNumber(security),
    });
    const baseline = Buffer.from(
        JSON.stringify({
            format: "livesync-bootstrap-baseline:1",
            pluginId: manifest.id,
            releaseNumber: readReleaseNumber(security),
            files,
        })
    );
    const baselineSha256 = hash(baseline);
    await writeFile("bootstrap-baseline.json", baseline);
    const bootstrapStyles = Buffer.alloc(0);
    await writeFile("bootstrap-styles.css", bootstrapStyles);
    await esbuild.build({
        entryPoints: ["src/serviceFeatures/releaseInstall/bootstrap.ts"],
        outfile: "bootstrap.js",
        bundle: true,
        format: "cjs",
        target: "es2018",
        platform: "browser",
        external: ["obsidian"],
        minify: true,
        define: {
            LIVESYNC_BOOTSTRAP_BASELINE_SHA256: JSON.stringify(baselineSha256),
            SECURITY_RELEASE_MARKER: JSON.stringify(releaseMarkerText(security)),
        },
    });
    await writeFile(
        "bootstrap-installation.json",
        JSON.stringify(
            {
                format: 1,
                protocol: 1,
                pluginId: manifest.id,
                baselineReleaseNumber: readReleaseNumber(security),
                files: [
                    { source: "bootstrap.js", target: "main.js", sha256: hash(await readFile("bootstrap.js")) },
                    { source: "manifest.json", target: "manifest.json", sha256: hash(await readFile("manifest.json")) },
                    { source: "bootstrap-styles.css", target: "styles.css", sha256: hash(bootstrapStyles) },
                    {
                        source: "bootstrap-baseline.json",
                        target: `release-runtime/${baselineSha256}.livesync-release`,
                        sha256: baselineSha256,
                    },
                ],
            },
            null,
            2
        ) + "\n"
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildBootstrap();
