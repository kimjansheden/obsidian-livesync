import { FileSystemAdapter, type App } from "obsidian";
import {
    createProtectedPathLinkGuard,
    noProtectedPathLinkGuard,
    type ProtectedPathLinkGuard,
} from "./protectedPathLinkGuard";
import { TRUSTED_RELEASE_KEYS_FILE } from "@/serviceFeatures/releaseInstall/trustedReleaseKeys";

/** The slices of Node's `fs` and `path` the guard needs, obtained at runtime so nothing is bundled for mobile. */
interface NodeFs {
    existsSync(path: string): boolean;
    realpathSync: { (path: string): string; native?: (path: string) => string };
}
interface NodePath {
    resolve(...segments: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
}

/**
 * The link guard for the running platform. On desktop it resolves real paths with Node, so a write which a symbolic
 * link or junction resolves into the plug-in folder or its keys file is refused. On mobile, or wherever the file
 * system has no links to follow and Node is unavailable, it is a no-op: a vault path resolves only where it is spelled.
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
        protectedPaths: [pluginDirectory, `${pluginDirectory}/${TRUSTED_RELEASE_KEYS_FILE}`],
        fs: {
            exists: (path) => Promise.resolve(nodeFs.existsSync(path)),
            realpath: (path) => Promise.resolve(realpathSync(path)),
        },
        path: {
            resolve: (...segments) => nodePath.resolve(...segments),
            relative: (from, to) => nodePath.relative(from, to),
            isAbsolute: (path) => nodePath.isAbsolute(path),
        },
    });
}
