import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { createTrustedReleaseKeysPathMatcher } from "@/serviceFeatures/releaseInstall/trustedReleaseKeys";
import { ObsidianStorageAdapter } from "./ObsidianStorageAdapter";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { PathAliasGuard, createPathAliasGuard } from "./pathAliasGuard";
import { createProtectedPathLinkGuard } from "./protectedPathLinkGuard";
import {
    ALIAS_PATHS,
    CONFIG_DIRECTORY,
    KEYS_FILE,
    MAIN_JS,
    PLUGIN_DIRECTORY,
    createSyntheticVault,
    type SyntheticFileSystem,
} from "./_syntheticFileSystem";

const REFUSAL = "Refusing a path which reaches an existing entry by a name its folder does not list.";
const publication = { expectedSize: 3, shouldPublish: async () => true } as never;

async function* parts() {
    yield new Uint8Array([1, 2, 3]);
}

function storageAdapterOver(files: SyntheticFileSystem, guard?: PathAliasGuard) {
    const app = files.app() as unknown as App;
    return new ObsidianStorageAdapter(app, createTrustedReleaseKeysPathMatcher(PLUGIN_DIRECTORY), guard);
}

/** The folder part of a path. */
const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

describe("a path which reaches an existing entry by a name its folder does not list", () => {
    it.each(ALIAS_PATHS)("the synthetic file system resolves %s", async (_kind, aliasPath, reaches) => {
        const files = createSyntheticVault();

        expect(await files.exists(aliasPath)).toBe(true);
        expect(await files.read(aliasPath)).toBe(await files.read(reaches));
        // No folder lists the entry under that path; every listed path is in the snapshot.
        expect(Object.keys(files.snapshot())).toContain(reaches);
        expect(Object.keys(files.snapshot())).not.toContain(aliasPath);
    });

    it("would be written through, if nothing refused it", async () => {
        const files = createSyntheticVault();
        // A guard which takes every name for a listed one.
        const permissive = new PathAliasGuard({ isIndexed: () => true, exists: files.exists, list: async () => [] });
        const adapter = storageAdapterOver(files, permissive);

        await adapter.write("OBSIDI~1/plugins/obsidian-livesync/main.js", "replaced");
        await adapter.write(`${PLUGIN_DIRECTORY}/TRUSTE~1.JSO`, "replaced");

        expect(await files.read(MAIN_JS)).toBe("replaced");
        expect(await files.read(KEYS_FILE)).toBe("replaced");
    });

    it.each(ALIAS_PATHS)(
        "is refused for %s: write, append, removal and directory creation",
        async (_kind, aliasPath, reaches) => {
            const files = createSyntheticVault();
            const adapter = storageAdapterOver(files);
            const before = files.snapshot();

            await expect(adapter.write(aliasPath, "replaced")).rejects.toThrow(REFUSAL);
            await expect(adapter.writeBinary(aliasPath, new ArrayBuffer(2))).rejects.toThrow(REFUSAL);
            await expect(adapter.append(aliasPath, "appended")).rejects.toThrow(REFUSAL);
            await expect(adapter.writeBinaryInParts(aliasPath, parts(), publication)).rejects.toThrow(REFUSAL);
            await expect(adapter.remove(aliasPath)).rejects.toThrow(REFUSAL);
            await expect(adapter.mkdir(aliasPath)).rejects.toThrow(REFUSAL);
            // Neither is anything created below the entry which the alias reaches, nor beside it through the alias
            // of its folder.
            await expect(adapter.write(`${aliasPath}/below.json`, "{}")).rejects.toThrow(REFUSAL);
            if (folderOf(aliasPath) !== folderOf(reaches)) {
                await expect(adapter.mkdir(`${folderOf(aliasPath)}/new-folder`)).rejects.toThrow(REFUSAL);
                await expect(adapter.write(`${folderOf(aliasPath)}/new.json`, "{}")).rejects.toThrow(REFUSAL);
            }

            expect(files.changes()).toEqual([]);
            expect(files.snapshot()).toEqual(before);
        }
    );

    it.each([
        ["a file to create", (vault: ObsidianVaultAdapter, path: string) => vault.create(path, "text")],
        [
            "a binary file to create",
            (vault: ObsidianVaultAdapter, path: string) => vault.createBinary(path, new ArrayBuffer(2)),
        ],
        [
            "the target of a rename",
            (vault: ObsidianVaultAdapter, path: string) => vault.rename({ path: "notes/a.md" } as TFile, path),
        ],
    ])("is refused by the vault API for %s which is not in the index", async (_route, change) => {
        const files = createSyntheticVault();
        const app = files.app();
        const vault = new ObsidianVaultAdapter(app as unknown as App);
        const before = files.snapshot();

        await expect(change(vault, "OBSIDI~1/plugins/obsidian-livesync/note.md")).rejects.toThrow(REFUSAL);
        await expect(change(vault, `${CONFIG_DIRECTORY}/plugins/OBSIDI~1/note.md`)).rejects.toThrow(REFUSAL);
        await expect(change(vault, `${PLUGIN_DIRECTORY}/ma�in.js`)).rejects.toThrow(REFUSAL);

        expect(app.vault.create).not.toHaveBeenCalled();
        expect(app.vault.createBinary).not.toHaveBeenCalled();
        expect(app.vault.rename).not.toHaveBeenCalled();
        expect(files.snapshot()).toEqual(before);
    });

    it("lets the vault API create a file and rename one to a name which is new", async () => {
        const files = createSyntheticVault();
        const app = files.app();
        const vault = new ObsidianVaultAdapter(app as unknown as App);

        await vault.create("notes/created.md", "text");
        await vault.rename({ path: "notes/a.md" } as TFile, "notes/renamed.md");

        expect(app.vault.create).toHaveBeenCalledOnce();
        expect(app.vault.rename).toHaveBeenCalledOnce();
        expect(files.calls.list).toBe(0);
    });
});

describe("a path which uses the names its folders list", () => {
    it("is written, appended to and removed as before, also in another case", async () => {
        const files = createSyntheticVault();
        const adapter = storageAdapterOver(files);

        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "new settings");
        await adapter.append(".Obsidian/Plugins/Obsidian-LiveSync/DATA.json", " and more");
        await adapter.write(`${PLUGIN_DIRECTORY}/created.json`, "{}");
        await adapter.remove(`${PLUGIN_DIRECTORY}/created.json`);

        expect(await files.read(`${PLUGIN_DIRECTORY}/data.json`)).toBe("new settings and more");
        expect(files.snapshot()).not.toHaveProperty(`${PLUGIN_DIRECTORY}/created.json`);
    });

    it("is written in another Unicode normalisation than the one the folder lists", async () => {
        const files = createSyntheticVault();
        const listedName = "café.css".normalize("NFD");
        files.add(`${CONFIG_DIRECTORY}/snippets/${listedName}`, "old");
        const adapter = storageAdapterOver(files);

        await adapter.write(`${CONFIG_DIRECTORY}/snippets/${"café.css".normalize("NFC")}`, "new");

        expect(await files.read(`${CONFIG_DIRECTORY}/snippets/${listedName}`)).toBe("new");
    });

    it("creates folders and files which do not exist yet, also in a folder created a moment ago", async () => {
        const files = createSyntheticVault();
        const adapter = storageAdapterOver(files);
        // The root has been listed before the new folder exists.
        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "listed");

        await adapter.mkdir(`${CONFIG_DIRECTORY}/snippets`);
        await adapter.mkdir(`${CONFIG_DIRECTORY}/snippets/deep`);
        await adapter.write(`${CONFIG_DIRECTORY}/snippets/deep/new.css`, "a {}");
        await adapter.mkdir("attachments");
        await adapter.writeBinary("attachments/new.bin", new TextEncoder().encode("bytes").buffer);

        expect(await files.read(`${CONFIG_DIRECTORY}/snippets/deep/new.css`)).toBe("a {}");
        expect(await files.read("attachments/new.bin")).toBe("bytes");
    });

    it("still refuses the trust file under its own name, as a write-protected file", async () => {
        const files = createSyntheticVault();
        const adapter = storageAdapterOver(files);

        await expect(adapter.write(KEYS_FILE, "replaced")).rejects.toThrow("write-protected");
        await expect(adapter.remove(".OBSIDIAN/PLUGINS/OBSIDIAN-LIVESYNC/TRUSTED-RELEASE-KEYS.JSON")).rejects.toThrow(
            "write-protected"
        );

        expect(await files.read(KEYS_FILE)).toBe("the trusted keys");
    });
});

describe("what the check costs", () => {
    it("lists no folder for files written into a folder which the vault index holds", async () => {
        const files = createSyntheticVault();
        const app = files.app();
        const adapter = storageAdapterOver(files);
        const vault = new ObsidianVaultAdapter(app as unknown as App);

        for (let index = 0; index < 20; index++) await adapter.write(`notes/new-${index}.bin`, "content");
        await adapter.write("notes/a.md", "an indexed file, written again");
        await adapter.mkdir("notes").catch(() => undefined);
        await vault.create("notes/created.md", "text");
        await adapter.remove("notes/a.md");

        expect(files.calls.list).toBe(0);
        // One look at whether the file exists, for each path which the index does not hold; none for those it holds.
        expect(files.calls.exists).toBe(21);
    });

    it("lists each folder on the way once for the first hidden file, and none again within a second", async () => {
        const files = createSyntheticVault();
        let now = 1_000_000;
        const guard = new PathAliasGuard(
            {
                isIndexed: (path) => files.index.has(path),
                exists: files.exists,
                list: async (directory) => {
                    const listing = await files.list(directory);
                    return [...listing.files, ...listing.folders];
                },
            },
            () => now
        );
        const adapter = storageAdapterOver(files, guard);

        // The folders are made first, as for every file written from a document, and then the file is written.
        for (const folder of [CONFIG_DIRECTORY, `${CONFIG_DIRECTORY}/plugins`, PLUGIN_DIRECTORY]) {
            await adapter.mkdir(folder).catch(() => undefined);
        }
        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "first");
        // The root, the configuration folder, its plug-in folder, and the folder of the file.
        expect(files.calls.list).toBe(4);

        now += 900;
        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "second");
        await adapter.write(`${PLUGIN_DIRECTORY}/main.js`, "also listed");
        expect(files.calls.list).toBe(4);

        now += 1_001;
        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "third");
        expect(files.calls.list).toBe(8);
    });

    it("does not trust an earlier listing for a name it does not hold", async () => {
        const files = createSyntheticVault();
        const adapter = storageAdapterOver(files);
        await adapter.write(`${PLUGIN_DIRECTORY}/data.json`, "listed");
        // An alias appears in a folder which was listed a moment ago: it is still not a listed name.
        files
            .add(`${PLUGIN_DIRECTORY}/styles.css`, "the styles")
            .alias(`${PLUGIN_DIRECTORY}/styles.css`, "STYLES~1.CSS");

        await expect(adapter.write(`${PLUGIN_DIRECTORY}/STYLES~1.CSS`, "replaced")).rejects.toThrow(REFUSAL);
        await adapter.write(`${PLUGIN_DIRECTORY}/styles.css`, "written under its own name");

        expect(await files.read(`${PLUGIN_DIRECTORY}/styles.css`)).toBe("written under its own name");
    });
});

// The aliases of a real file system are found by trying: an alias is a name which the file system resolves to an
// entry although the folder of that entry does not list it. Where the file system makes none, nothing is tested.
const fold = (name: string) => name.normalize("NFC").toLowerCase();
const realRoot = mkdtempSync(join(tmpdir(), "alias-guard-"));
const REAL_FOLDER = "configuration-folder";
const REAL_FILE = "trusted-release-keys.json";
mkdirSync(join(realRoot, REAL_FOLDER));
writeFileSync(join(realRoot, REAL_FOLDER, REAL_FILE), "the trusted keys");
afterAll(() => rmSync(realRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function isAlias(folder: string, name: string): boolean {
    try {
        return (
            existsSync(join(realRoot, folder, name)) &&
            !readdirSync(join(realRoot, folder)).some((listed) => fold(listed) === fold(name))
        );
    } catch {
        return false;
    }
}

/** Names which some file systems resolve to `name`: its short form, trailing characters, ignorable code points. */
function aliasCandidates(name: string): string[] {
    const [base, extension = ""] = name.split(/\.(?=[^.]*$)/u);
    const shortName = `${base.slice(0, 6).toUpperCase()}~1${extension ? `.${extension.slice(0, 3).toUpperCase()}` : ""}`;
    return [shortName, `${name}.`, `${name} `, `${name[0]}\u200B${name.slice(1)}`, `${name[0]}�${name.slice(1)}`];
}

const realAliasPaths = [
    ...aliasCandidates(REAL_FOLDER)
        .filter((alias) => isAlias("", alias))
        .map((alias) => `${alias}/${REAL_FILE}`),
    ...aliasCandidates(REAL_FILE)
        .filter((alias) => isAlias(REAL_FOLDER, alias))
        .map((alias) => `${REAL_FOLDER}/${alias}`),
];

function realApp() {
    const full = (path: string) => join(realRoot, path === "/" ? "" : path);
    return {
        vault: {
            getAbstractFileByPath: () => null,
            adapter: {
                exists: async (path: string) => await Promise.resolve(existsSync(full(path))),
                list: async (path: string) => {
                    const prefix = path === "/" || path === "" ? "" : `${path}/`;
                    const names = readdirSync(full(path));
                    const isFile = (name: string) => statSync(join(full(path), name)).isFile();
                    return await Promise.resolve({
                        files: names.filter(isFile).map((name) => `${prefix}${name}`),
                        folders: names.filter((name) => !isFile(name)).map((name) => `${prefix}${name}`),
                    });
                },
                write: async (path: string, data: string) => await Promise.resolve(writeFileSync(full(path), data)),
                remove: async (path: string) => await Promise.resolve(rmSync(full(path))),
                mkdir: async (path: string) => await Promise.resolve(void mkdirSync(full(path))),
            },
        },
    };
}

describe("on the file system of this machine", () => {
    const realFile = join(realRoot, REAL_FOLDER, REAL_FILE);

    it("writes and removes a file under the name its folder lists", async () => {
        const app = realApp();
        const adapter = new ObsidianStorageAdapter(app as unknown as App, () => false, createPathAliasGuard(app));

        await adapter.write(`${REAL_FOLDER}/other.json`, "{}");
        await adapter.mkdir(`${REAL_FOLDER}/new-folder`);
        await adapter.remove(`${REAL_FOLDER}/other.json`);

        expect(existsSync(join(realRoot, REAL_FOLDER, "other.json"))).toBe(false);
        expect(existsSync(join(realRoot, REAL_FOLDER, "new-folder"))).toBe(true);
    });

    it.skipIf(realAliasPaths.length === 0)(
        `refuses every alias which this file system makes (${realAliasPaths.length} found)`,
        async () => {
            const app = realApp();
            const adapter = new ObsidianStorageAdapter(app as unknown as App, () => false, createPathAliasGuard(app));

            for (const aliasPath of realAliasPaths) {
                // The file system does reach the file through this name.
                expect(readFileSync(join(realRoot, aliasPath), "utf8"), aliasPath).toBe("the trusted keys");

                await expect(adapter.write(aliasPath, "replaced"), aliasPath).rejects.toThrow(REFUSAL);
                await expect(adapter.remove(aliasPath), aliasPath).rejects.toThrow(REFUSAL);
                await expect(adapter.mkdir(aliasPath), aliasPath).rejects.toThrow(REFUSAL);
                // Where the alias is that of the folder, nothing is made in the folder through it either.
                if (folderOf(aliasPath) !== REAL_FOLDER) {
                    await expect(
                        adapter.mkdir(`${folderOf(aliasPath)}/made-through-an-alias`),
                        aliasPath
                    ).rejects.toThrow(REFUSAL);
                }
            }

            expect(readFileSync(realFile, "utf8")).toBe("the trusted keys");
            expect(readdirSync(join(realRoot, REAL_FOLDER)).sort()).toEqual(["new-folder", REAL_FILE].sort());
        }
    );
});

describe("a path which a symbolic link or junction resolves into the plug-in folder", () => {
    const PLUGIN_REL = ".obsidian/plugins/obsidian-livesync";
    const KEYS_REL = `${PLUGIN_REL}/trusted-release-keys.json`;
    const REFUSAL = "symbolic link or junction";

    /** A real vault whose `updates` is a junction into the plug-in folder, which holds main.js and the keys file. */
    function realVaultWithJunction(): string {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "link-guard-")));
        mkdirSync(join(root, PLUGIN_REL), { recursive: true });
        writeFileSync(join(root, PLUGIN_REL, "main.js"), "the real plug-in code");
        writeFileSync(join(root, KEYS_REL), "the trusted keys");
        mkdirSync(join(root, "notes"));
        writeFileSync(join(root, "notes", "a.md"), "a note");
        // A junction needs no privilege on Windows, where a file symlink would; on Linux a directory symlink is made.
        symlinkSync(join(root, PLUGIN_REL), join(root, "updates"), "junction");
        return root;
    }

    function appOver(root: string) {
        const full = (path: string) => join(root, path === "/" ? "" : path);
        return {
            vault: {
                getAbstractFileByPath: () => null,
                adapter: {
                    exists: async (path: string) => await Promise.resolve(existsSync(full(path))),
                    list: async (path: string) => {
                        const prefix = path === "/" || path === "" ? "" : `${path}/`;
                        const names = readdirSync(full(path));
                        const isFile = (name: string) => statSync(join(full(path), name)).isFile();
                        return await Promise.resolve({
                            files: names.filter(isFile).map((name) => `${prefix}${name}`),
                            folders: names.filter((name) => !isFile(name)).map((name) => `${prefix}${name}`),
                        });
                    },
                    write: async (path: string, data: string) => await Promise.resolve(writeFileSync(full(path), data)),
                    writeBinary: async () => await Promise.resolve(),
                    append: async (path: string, data: string) =>
                        await Promise.resolve(writeFileSync(full(path), data, { flag: "a" })),
                    remove: async (path: string) => await Promise.resolve(rmSync(full(path))),
                    mkdir: async (path: string) => await Promise.resolve(void mkdirSync(full(path))),
                },
            },
        };
    }

    function guardOver(root: string, onRealpath?: () => void) {
        return createProtectedPathLinkGuard({
            vaultBasePath: root,
            protectedPaths: [PLUGIN_REL, KEYS_REL],
            fs: {
                exists: async (path) => await Promise.resolve(existsSync(path)),
                realpath: async (path) => {
                    onRealpath?.();
                    return await Promise.resolve((realpathSync.native ?? realpathSync)(path));
                },
            },
            path: { resolve, relative, isAbsolute },
        });
    }

    it("refuses every write a junction resolves into the plug-in folder or its keys file", async () => {
        const root = realVaultWithJunction();
        try {
            const app = appOver(root) as unknown as App;
            const adapter = new ObsidianStorageAdapter(app, () => false, createPathAliasGuard(app), guardOver(root));

            // The junction really does reach the protected files through a path no rule spells as hidden.
            expect(readFileSync(join(root, "updates/main.js"), "utf8")).toBe("the real plug-in code");

            await expect(adapter.write("updates/main.js", "evil")).rejects.toThrow(REFUSAL);
            await expect(adapter.writeBinary("updates/main.js", new ArrayBuffer(2))).rejects.toThrow(REFUSAL);
            await expect(adapter.append("updates/main.js", "evil")).rejects.toThrow(REFUSAL);
            await expect(adapter.remove("updates/main.js")).rejects.toThrow(REFUSAL);
            await expect(adapter.mkdir("updates/made")).rejects.toThrow(REFUSAL);
            await expect(adapter.write("updates/trusted-release-keys.json", "evil")).rejects.toThrow(REFUSAL);

            const vault = new ObsidianVaultAdapter(app, createPathAliasGuard(app), guardOver(root));
            await expect(vault.rename({ path: "notes/a.md" } as TFile, "updates/main.js")).rejects.toThrow(REFUSAL);
            await expect(vault.create("updates/new.js", "evil")).rejects.toThrow(REFUSAL);

            // Nothing reached the real files.
            expect(readFileSync(join(root, PLUGIN_REL, "main.js"), "utf8")).toBe("the real plug-in code");
            expect(readFileSync(join(root, KEYS_REL), "utf8")).toBe("the trusted keys");
        } finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    it("allows an ordinary path and resolves a real path only when a segment exists, never for a brand-new file", async () => {
        const root = realVaultWithJunction();
        try {
            let realpaths = 0;
            const app = appOver(root) as unknown as App;
            const guard = guardOver(root, () => realpaths++);
            const adapter = new ObsidianStorageAdapter(app, () => false, createPathAliasGuard(app), guard);

            // A brand-new top-level file: nothing on its path exists, so no real path is resolved at all.
            await adapter.write("fresh.md", "content");
            expect(realpaths).toBe(0);
            expect(readFileSync(join(root, "fresh.md"), "utf8")).toBe("content");

            // A file in an existing ordinary folder: one realpath of the existing prefix, not a link, so allowed.
            realpaths = 0;
            await adapter.write("notes/b.md", "more");
            expect(realpaths).toBe(1);
            expect(readFileSync(join(root, "notes/b.md"), "utf8")).toBe("more");
        } finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
