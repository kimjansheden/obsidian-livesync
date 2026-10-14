import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import {
    createOwnPluginRemovalProtectedPathMatcher,
    createOwnPluginProtectedPathMatcher,
} from "@/serviceFeatures/releaseInstall/trustedReleaseKeys";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { PathAliasGuard } from "./pathAliasGuard";
import { createProtectedPathLinkGuard, type ProtectedPathLinkGuard } from "./protectedPathLinkGuard";

const PLUGIN = ".obsidian/plugins/obsidian-livesync";
const indexed = new PathAliasGuard({
    isIndexed: () => true,
    exists: async () => true,
    list: async () => [],
});
const routes = ["modify", "modifyBinary"] as const;

function fixture(linkGuard?: ProtectedPathLinkGuard, aliasGuard = indexed) {
    const modify = vi.fn(async () => {});
    const modifyBinary = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const trashFile = vi.fn(async () => {});
    const app = { vault: { modify, modifyBinary, rename }, fileManager: { trashFile } } as unknown as App;
    return {
        modify,
        modifyBinary,
        rename,
        trashFile,
        adapter: new ObsidianVaultAdapter(
            app,
            aliasGuard,
            linkGuard,
            createOwnPluginProtectedPathMatcher(PLUGIN),
            createOwnPluginRemovalProtectedPathMatcher(PLUGIN)
        ),
    };
}

async function write(adapter: ObsidianVaultAdapter, route: (typeof routes)[number], path: string) {
    const file = { path } as TFile;
    if (route === "modify") await adapter.modify(file, "replacement");
    else await adapter.modifyBinary(file, new TextEncoder().encode("replacement").buffer);
}

describe("indexed rename protection", () => {
    it("refuses a source link which resolves into the protected plug-in directory", async () => {
        const source = "updates/main.js";
        const target = "archive/main.js";
        const root = resolve(tmpdir(), "synthetic-rename-vault");
        const guard = createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [PLUGIN],
            fs: {
                exists: async () => true,
                realpath: async (path) => (path === resolve(root, source) ? resolve(root, PLUGIN, "main.js") : path),
                identity: async (path) => path,
            },
            path: { resolve, relative, isAbsolute },
        });
        const f = fixture(guard);

        await expect(f.adapter.rename({ path: source } as TFile, target)).rejects.toThrow("symbolic link or junction");

        expect(f.rename).not.toHaveBeenCalled();
    });

    it("checks both ordinary source and target paths before renaming", async () => {
        const assertNoLinkEscape = vi.fn(async () => {});
        const f = fixture({ assertNoLinkEscape });
        const file = { path: "notes/source.md" } as TFile;

        await f.adapter.rename(file, "notes/target.md");

        expect(assertNoLinkEscape.mock.calls).toEqual([[file.path, "remove"], ["notes/target.md"]]);
        expect(f.rename).toHaveBeenCalledExactlyOnceWith(file, "notes/target.md");
    });
});

describe.each(routes)("indexed file protection for %s", (route) => {
    it.each([
        "main.js",
        "manifest.json",
        "styles.css",
        "trusted-release-keys.json",
        "release-runtime/payload.livesync-release",
        "release-runtime/intent-sha.json",
        "release-runtime/attempt-sha.json",
        "release-runtime/accepted-sha.json",
    ])("refuses %s and its case and trailing-dot spellings before calling the host", async (name) => {
        const { adapter, modify, modifyBinary } = fixture();
        for (const path of [`${PLUGIN}/${name}`, `${PLUGIN}/${name}`.toUpperCase(), `${PLUGIN}/${name}.`]) {
            await expect(write(adapter, route, path)).rejects.toThrow("write-protected");
        }
        expect(modify).not.toHaveBeenCalled();
        expect(modifyBinary).not.toHaveBeenCalled();
    });

    it.each(["notes/café.md", "Notes/NOTE.md", `${PLUGIN}/data.json`, ".obsidian/plugins/other/main.js"])(
        "allows the indexed ordinary path %s after checking its destination",
        async (path) => {
            const assertNoLinkEscape = vi.fn(async () => {});
            const { adapter, modify, modifyBinary } = fixture({ assertNoLinkEscape });
            await write(adapter, route, path);
            expect(assertNoLinkEscape).toHaveBeenCalledExactlyOnceWith(path);
            expect(route === "modify" ? modify : modifyBinary).toHaveBeenCalledOnce();
        }
    );

    it("refuses an indexed file symlink whose resolved destination is a protected file", async () => {
        const root = resolve(tmpdir(), "synthetic-indexed-vault");
        const alias = "notes/code.md";
        const guard = createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [PLUGIN],
            fs: {
                exists: async () => true,
                realpath: async (path) => (path === resolve(root, alias) ? resolve(root, PLUGIN, "main.js") : path),
                identity: async (path) => path,
            },
            path: { resolve, relative, isAbsolute },
        });
        const { adapter, modify, modifyBinary } = fixture(guard);
        await expect(write(adapter, route, alias)).rejects.toThrow("symbolic link or junction");
        expect(modify).not.toHaveBeenCalled();
        expect(modifyBinary).not.toHaveBeenCalled();
    });

    it("refuses the resolved target when a protected file is itself a symlink", async () => {
        const root = resolve(tmpdir(), "synthetic-protected-link-vault");
        const protectedPath = `${PLUGIN}/trusted-release-keys.json`;
        const target = "notes/device-keys.json";
        const guard = createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [protectedPath],
            fs: {
                exists: async () => true,
                realpath: async (path) => (path === resolve(root, protectedPath) ? resolve(root, target) : path),
                identity: async (path) => path,
            },
            path: { resolve, relative, isAbsolute },
        });
        const { adapter, modify, modifyBinary } = fixture(guard);

        await expect(write(adapter, route, target)).rejects.toThrow("symbolic link or junction");

        expect(modify).not.toHaveBeenCalled();
        expect(modifyBinary).not.toHaveBeenCalled();
    });

    it("refuses an indexed file when its native destination cannot be resolved", async () => {
        const root = resolve(tmpdir(), "synthetic-indexed-vault");
        const guard = createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [PLUGIN],
            fs: {
                exists: async () => true,
                realpath: async () => {
                    throw new Error("resolution failed");
                },
                identity: async (path) => path,
            },
            path: { resolve, relative, isAbsolute },
        });
        const { adapter, modify, modifyBinary } = fixture(guard);
        await expect(write(adapter, route, "notes/file.md")).rejects.toThrow("symbolic link or junction");
        expect(modify).not.toHaveBeenCalled();
        expect(modifyBinary).not.toHaveBeenCalled();
    });

    it("refuses existing indexed files reached through a native directory junction or symlink", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "indexed-link-guard-")));
        try {
            mkdirSync(join(root, PLUGIN), { recursive: true });
            writeFileSync(join(root, PLUGIN, "main.js"), "synthetic plug-in code");
            writeFileSync(join(root, PLUGIN, "trusted-release-keys.json"), "synthetic trust keys");
            // Windows junctions need no symlink privilege; POSIX creates a directory symlink for this type.
            symlinkSync(join(root, PLUGIN), join(root, "updates"), "junction");
            const guard = createProtectedPathLinkGuard({
                vaultBasePath: root,
                protectedPaths: [PLUGIN],
                fs: {
                    exists: async (path) => existsSync(path),
                    realpath: async (path) => (realpathSync.native ?? realpathSync)(path),
                    identity: async (path) => {
                        const stat = statSync(path, { bigint: true });
                        return `${String(stat.dev)}:${String(stat.ino)}`;
                    },
                },
                path: { resolve, relative, isAbsolute },
            });
            const { adapter, modify, modifyBinary } = fixture(guard);
            for (const name of ["main.js", "trusted-release-keys.json"]) {
                const alias = `updates/${name}`;
                expect(existsSync(join(root, alias))).toBe(true);
                await expect(write(adapter, route, alias)).rejects.toThrow("symbolic link or junction");
            }
            expect(modify).not.toHaveBeenCalled();
            expect(modifyBinary).not.toHaveBeenCalled();
            expect(readFileSync(join(root, PLUGIN, "main.js"), "utf8")).toBe("synthetic plug-in code");
            expect(readFileSync(join(root, PLUGIN, "trusted-release-keys.json"), "utf8")).toBe("synthetic trust keys");
        } finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});

describe.each(["delete", "trash"] as const)("indexed removal protection for %s", (route) => {
    it.each([
        ".obsidian",
        ".obsidian/plugins",
        PLUGIN,
        `${PLUGIN}/main.js`,
        `${PLUGIN}/trusted-release-keys.json`,
        `${PLUGIN}/release-runtime`,
        `${PLUGIN}/release-runtime/intent-sha.json`,
    ])("refuses protected file/subtree/ancestor %s", async (path) => {
        const f = fixture();
        await expect(f.adapter[route]({ path } as TFile)).rejects.toThrow("write-protected");
        expect(f.trashFile).not.toHaveBeenCalled();
    });
    it("refuses a junction into the protected runtime subtree", async () => {
        const root = resolve(tmpdir(), "synthetic-remove-vault");
        const link = createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [PLUGIN],
            fs: {
                exists: async () => true,
                realpath: async (path) =>
                    path === resolve(root, "updates/state.json")
                        ? resolve(root, PLUGIN, "release-runtime/accepted-sha.json")
                        : path,
                identity: async (path) => path,
            },
            path: { resolve, relative, isAbsolute },
        });
        const f = fixture(link);
        await expect(f.adapter[route]({ path: "updates/state.json" } as TFile)).rejects.toThrow(
            "symbolic link or junction"
        );
        expect(f.trashFile).not.toHaveBeenCalled();
    });
    it("refuses an existing unlisted short alias before calling trashFile", async () => {
        const alias = new PathAliasGuard({
            isIndexed: () => false,
            exists: async () => true,
            list: async () => [".obsidian"],
        });
        const f = fixture(undefined, alias);
        await expect(f.adapter[route]({ path: "OBSIDI~1/plugins/obsidian-livesync/main.js" } as TFile)).rejects.toThrow(
            "name its folder does not list"
        );
        expect(f.trashFile).not.toHaveBeenCalled();
    });
    it("allows ordinary indexed removals after all guards", async () => {
        const assertNoLinkEscape = vi.fn(async () => {});
        const f = fixture({ assertNoLinkEscape });
        const file = { path: "notes/ordinary.md" } as TFile;
        await f.adapter[route](file);
        expect(assertNoLinkEscape).toHaveBeenCalledExactlyOnceWith(file.path, "remove");
        expect(f.trashFile).toHaveBeenCalledExactlyOnceWith(file);
    });
});
