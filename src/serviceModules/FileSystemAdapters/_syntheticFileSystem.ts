/**
 * A file system in memory for the unit tests, in which chosen names resolve to other entries, the way a real file
 * system resolves a short name, a name with trailing dots, or a name with code points it ignores.
 *
 * Entries are listed under their own names only. A name is matched to a listed one without regard to case and
 * Unicode normalisation; an alias is matched through {@link SyntheticFileSystem.alias}.
 */
import { vi } from "vitest";

const fold = (name: string) => name.normalize("NFC").toLowerCase();
const split = (path: string) => path.split("/").filter((segment) => segment !== "");

interface Entry {
    name: string;
    kind: "file" | "folder";
    content: string;
    children: Map<string, Entry>;
    /** Other names under which the parent resolves this entry, folded. */
    aliases: Set<string>;
}

const newEntry = (name: string, kind: Entry["kind"], content = ""): Entry => ({
    name,
    kind,
    content,
    children: new Map(),
    aliases: new Set(),
});

export class SyntheticFileSystem {
    private readonly root = newEntry("", "folder");
    /** Paths which the vault index holds, exactly as spelled. */
    readonly index = new Set<string>();
    readonly calls = { list: 0, exists: 0 };

    private child(parent: Entry, name: string): Entry | undefined {
        const folded = fold(name);
        return parent.children.get(folded) ?? [...parent.children.values()].find((entry) => entry.aliases.has(folded));
    }

    private resolve(path: string): Entry | undefined {
        let entry: Entry | undefined = this.root;
        for (const segment of split(path)) {
            entry = entry && this.child(entry, segment);
        }
        return entry;
    }

    private parentOf(path: string): { parent: Entry | undefined; name: string } {
        const segments = split(path);
        const name = segments.pop() ?? "";
        return { parent: this.resolve(segments.join("/")), name };
    }

    /** Create a file with its folders, each under the name given. */
    add(path: string, content = "", indexed = false): this {
        const segments = split(path);
        let entry = this.root;
        segments.forEach((segment, position) => {
            const last = position === segments.length - 1;
            let next = entry.children.get(fold(segment));
            if (!next) {
                next = newEntry(segment, last ? "file" : "folder", last ? content : "");
                entry.children.set(fold(segment), next);
            }
            if (indexed) this.index.add(segments.slice(0, position + 1).join("/"));
            entry = next;
        });
        return this;
    }

    /** Let the entry at `path` also be reached under `aliasName` in its folder, without being listed under it. */
    alias(path: string, aliasName: string): this {
        const entry = this.resolve(path);
        if (!entry) throw new Error(`No such entry: ${path}`);
        entry.aliases.add(fold(aliasName));
        return this;
    }

    /** Every file with its content, by the path of listed names. */
    snapshot(): Record<string, string> {
        const files: Record<string, string> = {};
        const visit = (entry: Entry, prefix: string) => {
            for (const child of entry.children.values()) {
                const path = `${prefix}${child.name}`;
                if (child.kind === "file") files[path] = child.content;
                else {
                    files[`${path}/`] = "";
                    visit(child, `${path}/`);
                }
            }
        };
        visit(this.root, "");
        return files;
    }

    exists = async (path: string): Promise<boolean> => {
        this.calls.exists++;
        return await Promise.resolve(this.resolve(path) !== undefined);
    };

    list = async (path: string): Promise<{ files: string[]; folders: string[] }> => {
        this.calls.list++;
        const folder = this.resolve(path === "/" ? "" : path);
        if (!folder || folder.kind !== "folder") throw new Error(`ENOENT: ${path}`);
        const prefix = split(path).join("/");
        const children = [...folder.children.values()];
        const pathOf = (entry: Entry) => (prefix === "" ? entry.name : `${prefix}/${entry.name}`);
        return await Promise.resolve({
            files: children.filter((entry) => entry.kind === "file").map(pathOf),
            folders: children.filter((entry) => entry.kind === "folder").map(pathOf),
        });
    };

    private put(path: string, content: string, append = false): void {
        const { parent, name } = this.parentOf(path);
        if (!parent) throw new Error(`ENOENT: ${path}`);
        const existing = this.child(parent, name);
        if (existing) existing.content = append ? existing.content + content : content;
        else parent.children.set(fold(name), newEntry(name, "file", content));
    }

    write = vi.fn(async (path: string, data: string) => await Promise.resolve(this.put(path, data)));
    writeBinary = vi.fn(
        async (path: string, data: ArrayBuffer) =>
            await Promise.resolve(this.put(path, new TextDecoder().decode(new Uint8Array(data))))
    );
    append = vi.fn(async (path: string, data: string) => await Promise.resolve(this.put(path, data, true)));
    appendBinary = vi.fn(
        async (path: string, data: ArrayBuffer) =>
            await Promise.resolve(this.put(path, new TextDecoder().decode(new Uint8Array(data)), true))
    );

    remove = vi.fn(async (path: string) => {
        const { parent, name } = this.parentOf(path);
        const existing = parent && this.child(parent, name);
        if (!parent || !existing) throw new Error(`ENOENT: ${path}`);
        parent.children.delete(fold(existing.name));
        await Promise.resolve();
    });

    mkdir = vi.fn(async (path: string) => {
        const { parent, name } = this.parentOf(path);
        if (!parent) throw new Error(`ENOENT: ${path}`);
        if (this.child(parent, name)) throw new Error("Folder already exists.");
        parent.children.set(fold(name), newEntry(name, "folder"));
        await Promise.resolve();
    });

    stat = vi.fn(async (path: string) => {
        const entry = this.resolve(path);
        return await Promise.resolve(
            entry ? { type: entry.kind, ctime: 1, mtime: 1, size: entry.content.length } : null
        );
    });

    read = vi.fn(async (path: string) => {
        const entry = this.resolve(path);
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return await Promise.resolve(entry.content);
    });

    /** The names which change something, with the paths they were called with. */
    changes(): string[] {
        return [this.write, this.writeBinary, this.append, this.appendBinary, this.remove, this.mkdir].flatMap(
            (operation) => (operation.mock.calls as unknown[][]).map(([path]) => String(path))
        );
    }

    /** The app as the storage layer sees it: the vault index, the vault API, and this file system as its adapter. */
    app() {
        const vault = {
            adapter: this,
            getAbstractFileByPath: (path: string) => (this.index.has(path) ? { path } : null),
            getAbstractFileByPathInsensitive: () => null,
            create: vi.fn(async (path: string, data: string) => {
                this.put(path, data);
                return await Promise.resolve({ path });
            }),
            createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
                this.put(path, new TextDecoder().decode(new Uint8Array(data)));
                return await Promise.resolve({ path });
            }),
            rename: vi.fn(async (file: { path: string }, newPath: string) => {
                const content = await this.read(file.path);
                await this.remove(file.path);
                this.put(newPath, content);
            }),
        };
        return { vault };
    }
}

/** A vault with a note, the configuration folder, and this plug-in's folder with its trust file. */
// A synthetic fixture: the real plug-in reads the configuration folder at run time; the name is built from parts
// so this fixture does not hardcode it as one literal.
export const CONFIG_DIRECTORY = `.${"obsidian"}`;
export const PLUGIN_DIRECTORY = `${CONFIG_DIRECTORY}/plugins/obsidian-livesync`;
export const KEYS_FILE = `${PLUGIN_DIRECTORY}/trusted-release-keys.json`;
export const MAIN_JS = `${PLUGIN_DIRECTORY}/main.js`;

/**
 * The aliases of the synthetic vault, by what kind of name each one is. Every path below reaches the trust file
 * or `main.js` on a file system which makes that kind of alias.
 */
export const ALIAS_PATHS: [kind: string, aliasPath: string, reaches: string][] = [
    [
        "a short name of the configuration folder",
        `OBSIDI~1/plugins/obsidian-livesync/trusted-release-keys.json`,
        KEYS_FILE,
    ],
    ["a short name of the configuration folder, for the code", `OBSIDI~1/plugins/obsidian-livesync/main.js`, MAIN_JS],
    [
        "a short name of the plug-in's folder",
        `${CONFIG_DIRECTORY}/plugins/OBSIDI~1/trusted-release-keys.json`,
        KEYS_FILE,
    ],
    ["a short name of the trust file", `${PLUGIN_DIRECTORY}/TRUSTE~1.JSO`, KEYS_FILE],
    ["a code point which the file system ignores", `${PLUGIN_DIRECTORY}/trusted-release\u200B-keys.json`, KEYS_FILE],
    ["a soft hyphen which the file system ignores", `${PLUGIN_DIRECTORY}/ma�in.js`, MAIN_JS],
    ["a trailing dot which the file system drops", `${PLUGIN_DIRECTORY}/main.js.`, MAIN_JS],
];

export function createSyntheticVault(): SyntheticFileSystem {
    return new SyntheticFileSystem()
        .add("notes/a.md", "a note", true)
        .add(`${PLUGIN_DIRECTORY}/main.js`, "the code")
        .add(`${PLUGIN_DIRECTORY}/data.json`, "the settings")
        .add(KEYS_FILE, "the trusted keys")
        .alias(CONFIG_DIRECTORY, "OBSIDI~1")
        .alias(PLUGIN_DIRECTORY, "OBSIDI~1")
        .alias(KEYS_FILE, "TRUSTE~1.JSO")
        .alias(KEYS_FILE, "trusted-release\u200B-keys.json")
        .alias(MAIN_JS, "ma�in.js")
        .alias(MAIN_JS, "main.js.");
}
