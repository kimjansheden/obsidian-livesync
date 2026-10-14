import { FileSystemAdapter, type App } from "obsidian";
import {
    createProtectedPathLinkGuard,
    noProtectedPathLinkGuard,
    type ProtectedPathLinkGuard,
} from "./protectedPathLinkGuard";
import { OWN_PLUGIN_PROTECTED_FILES } from "@/serviceFeatures/releaseInstall/trustedReleaseKeys";

/** The slices of Node's `fs` and `path` the guard needs, obtained at runtime so nothing is bundled for mobile. */
interface NodeFs {
    existsSync(path: string): boolean;
    realpathSync: { (path: string): string; native?: (path: string) => string };
    statSync(path: string, options: { bigint: true }): { dev: bigint; ino: bigint };
}
interface NodePath {
    resolve(...segments: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
}

/**
 * The link guard for the running platform. On desktop it resolves real paths and file identities with Node, so a
 * symbolic link, junction or hard link cannot reach the plug-in's protected storage. On mobile, or wherever the
 * file system has no links to follow and Node is unavailable, it is a no-op: a vault path resolves only where it is spelled.
 */
export function createObsidianProtectedPathLinkGuard(app: App, pluginDirectory: string): ProtectedPathLinkGuard {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return noProtectedPathLinkGuard();
    const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
    if (typeof nodeRequire !== "function") return noProtectedPathLinkGuard();
    let nodeFs: NodeFs;
    let nodePath: NodePath;
    try {
        nodeFs = nodeRequire("fs") as NodeFs;
        nodePath = nodeRequire("path") as NodePath;
    } catch {
        return noProtectedPathLinkGuard();
    }
    const realpathSync = nodeFs.realpathSync.native ?? nodeFs.realpathSync;
    // Resolve the vault root itself, so a vault located under a symbolic link does not make every path look resolved
    // elsewhere; only links below the root then count. Fall back to the given base if it cannot be resolved.
    let vaultBasePath = adapter.getBasePath();
    try {
        vaultBasePath = realpathSync(vaultBasePath);
    } catch {
        /* keep the unresolved base */
    }
    return createProtectedPathLinkGuard({
        vaultBasePath,
        protectedPaths: [pluginDirectory, ...OWN_PLUGIN_PROTECTED_FILES.map((name) => `${pluginDirectory}/${name}`)],
        fs: {
            exists: (path) => Promise.resolve(nodeFs.existsSync(path)),
            realpath: (path) => Promise.resolve(realpathSync(path)),
            identity: (path) => {
                try {
                    const stat = nodeFs.statSync(path, { bigint: true });
                    return Promise.resolve(`${String(stat.dev)}:${String(stat.ino)}`);
                } catch (error) {
                    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
                        return Promise.resolve(undefined);
                    }
                    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        },
        path: {
            resolve: (...segments) => nodePath.resolve(...segments),
            relative: (from, to) => nodePath.relative(from, to),
            isAbsolute: (path) => nodePath.isAbsolute(path),
        },
    });
}
