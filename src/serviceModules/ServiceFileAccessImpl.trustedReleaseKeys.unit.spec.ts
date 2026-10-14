import { describe, expect, it, vi } from "vitest";

// The adapters which tell Obsidian's file objects apart are not exercised here: every path is a plain string.
vi.mock("@/deps.ts", () => ({
    normalizePath: (path: string) => path,
}));
vi.mock("./FileSystemAdapters/ObsidianTypeGuardAdapter", () => ({
    ObsidianTypeGuardAdapter: class ObsidianTypeGuardAdapter {
        isFile() {
            return false;
        }
        isFolder() {
            return false;
        }
    },
}));
vi.mock("./FileSystemAdapters/ObsidianConversionAdapter", () => ({
    ObsidianConversionAdapter: class ObsidianConversionAdapter {},
}));

import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { StorageAccessManager } from "@vrtmrz/livesync-commonlib/compat/managers/StorageProcessingManager";
import { createTrustedReleaseKeysPathMatcher } from "@/serviceFeatures/releaseInstall/trustedReleaseKeys";
import { FileAccessObsidian } from "./FileAccessObsidian";
import { ObsidianStorageAdapter } from "./FileSystemAdapters/ObsidianStorageAdapter";
import { createSyntheticVault } from "./FileSystemAdapters/_syntheticFileSystem";
import { ServiceFileAccessObsidian } from "./ServiceFileAccessImpl";

const PLUGIN_DIRECTORY = ".obsidian/plugins/obsidian-livesync";
const KEYS_FILE = `${PLUGIN_DIRECTORY}/trusted-release-keys.json`;
const KEYS_FILE_SPELLINGS = [
    KEYS_FILE,
    ".obsidian/plugins/obsidian-livesync/Trusted-Release-Keys.JSON",
    ".OBSIDIAN/PLUGINS/OBSIDIAN-LIVESYNC/TRUSTED-RELEASE-KEYS.JSON",
    ".obsidian/plugins//obsidian-livesync/trusted-release-keys.json",
    ".obsidian/plugins/obsidian-livesync/trusted-release-keys.json.",
];
/** Another file in the same folder, which is written and removed as before. */
const OTHER_FILE = `${PLUGIN_DIRECTORY}/data.json`;

/**
 * A native adapter over a small path tree, so the alias guard the storage layer now applies runs for real: a file
 * written under a name its folder lists is allowed, and only a name no folder lists is an alias. The plug-in's
 * folder and its files are present from the start; none is in the vault index, as hidden files are not.
 */
function createNativeAdapter() {
    // Folders and files which exist on disk, each spelled as its folder lists it.
    const entries = new Set<string>([
        ".obsidian",
        ".obsidian/plugins",
        PLUGIN_DIRECTORY,
        `${PLUGIN_DIRECTORY}/main.js`,
        `${PLUGIN_DIRECTORY}/data.json`,
        KEYS_FILE,
    ]);
    const folders = new Set<string>([".obsidian", ".obsidian/plugins", PLUGIN_DIRECTORY]);
    const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
    return {
        entries,
        exists: vi.fn(async (path: string) => entries.has(path)),
        list: vi.fn(async (path: string) => {
            const directory = path === "/" ? "" : path;
            const children = [...entries].filter((entry) => parentOf(entry) === directory);
            return {
                files: children.filter((entry) => !folders.has(entry)),
                folders: children.filter((entry) => folders.has(entry)),
            };
        }),
        stat: vi.fn(async () => ({ type: "file", ctime: 1, mtime: 1, size: 1 })),
        read: vi.fn(async () => "keys"),
        readBinary: vi.fn(async () => new ArrayBuffer(4)),
        write: vi.fn(async (path: string) => void entries.add(path)),
        writeBinary: vi.fn(async (path: string) => void entries.add(path)),
        append: vi.fn(async (path: string) => void entries.add(path)),
        appendBinary: vi.fn(async (path: string) => void entries.add(path)),
        remove: vi.fn(async (path: string) => void entries.delete(path)),
        mkdir: vi.fn(async (path: string) => {
            entries.add(path);
            folders.add(path);
        }),
        rename: vi.fn(async () => undefined),
        getFullPath: vi.fn((path: string) => `/vault/${path}`),
    };
}

/** The native calls which create, change or remove something. */
function mutations(native: ReturnType<typeof createNativeAdapter>) {
    return [
        native.write,
        native.writeBinary,
        native.append,
        native.appendBinary,
        native.remove,
        native.mkdir,
        native.rename,
    ]
        .flatMap((mutation) => mutation.mock.calls as unknown[][])
        .map(([path]) => path);
}

async function* parts() {
    yield new Uint8Array([1, 2, 3]);
}

const publication = { expectedSize: 3, shouldPublish: async () => true } as never;

function createStorageAdapter() {
    const native = createNativeAdapter();
    // Nothing is in the vault index, as hidden files are not; the alias guard then lists the folders on the way.
    const app = { vault: { adapter: native, getAbstractFileByPath: () => null } } as unknown as App;
    return { native, adapter: new ObsidianStorageAdapter(app, createTrustedReleaseKeysPathMatcher(PLUGIN_DIRECTORY)) };
}

/** The storage access of the plug-in as `main.ts` composes it, over a synthetic native adapter. */
function createStorageAccess() {
    const native = createNativeAdapter();
    const app = {
        vault: {
            adapter: native,
            getAbstractFileByPath: () => null,
            getAbstractFileByPathInsensitive: () => null,
        },
    } as unknown as App;
    const storageAccessManager = new StorageAccessManager();
    const API = { addLog: vi.fn() };
    const setting = { currentSettings: () => ({ ...DEFAULT_SETTINGS }) };
    const vaultAccess = new FileAccessObsidian(
        app,
        { storageAccessManager, vaultService: {}, settingService: setting, APIService: API, pathService: {} } as never,
        createTrustedReleaseKeysPathMatcher(PLUGIN_DIRECTORY)
    );
    const storageAccess = new ServiceFileAccessObsidian({
        API,
        setting,
        vault: {},
        appLifecycle: { onFirstInitialise: { addHandler: vi.fn() } },
        fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } },
        storageEventManager: {},
        storageAccessManager,
        vaultAccess,
    } as never);
    return { native, storageAccess };
}

describe("the storage adapter and the trusted release keys", () => {
    it.each(KEYS_FILE_SPELLINGS)("refuses every way to create, change or remove %s", async (path) => {
        const { native, adapter } = createStorageAdapter();
        const refusal = "Refusing to change a write-protected file.";

        await expect(adapter.write(path, "{}")).rejects.toThrow(refusal);
        await expect(adapter.writeBinary(path, new ArrayBuffer(2))).rejects.toThrow(refusal);
        await expect(adapter.append(path, "{}")).rejects.toThrow(refusal);
        await expect(adapter.remove(path)).rejects.toThrow(refusal);
        await expect(adapter.mkdir(path)).rejects.toThrow(refusal);
        await expect(adapter.writeBinaryInParts(path, parts(), publication)).rejects.toThrow(refusal);

        expect(mutations(native)).toEqual([]);
    });

    it("still reads the file, which the plug-in itself does to learn its trusted keys", async () => {
        const { adapter } = createStorageAdapter();

        await expect(adapter.exists(KEYS_FILE)).resolves.toBe(true);
        await expect(adapter.read(KEYS_FILE)).resolves.toBe("keys");
        await expect(adapter.readBinary(KEYS_FILE)).resolves.toBeInstanceOf(ArrayBuffer);
        await expect(adapter.stat(KEYS_FILE)).resolves.toMatchObject({ type: "file" });
    });

    it("writes and removes another file of the plug-in's folder as before", async () => {
        const { native, adapter } = createStorageAdapter();

        await adapter.write(OTHER_FILE, "{}");
        await adapter.writeBinary(`${OTHER_FILE}.bin`, new ArrayBuffer(2));
        await adapter.append(`${OTHER_FILE}.log`, "line");
        await adapter.remove(OTHER_FILE);
        await adapter.mkdir(PLUGIN_DIRECTORY);

        expect(mutations(native)).toEqual([
            OTHER_FILE,
            `${OTHER_FILE}.bin`,
            `${OTHER_FILE}.log`,
            OTHER_FILE,
            PLUGIN_DIRECTORY,
        ]);
    });

    it("protects nothing unless it is told what to protect", async () => {
        const native = createNativeAdapter();
        const app = { vault: { adapter: native, getAbstractFileByPath: () => null } } as unknown as App;
        const adapter = new ObsidianStorageAdapter(app);

        // The trust file is listed under its own name, so only the write-protection guard could refuse it; without
        // one, it is written like any other file.
        await adapter.write(KEYS_FILE, "{}");

        expect(native.write).toHaveBeenCalledOnce();
    });
});

describe("the storage access of synchronised content and the trusted release keys", () => {
    it.each(KEYS_FILE_SPELLINGS)("writes %s by none of its routes", async (path) => {
        const { native, storageAccess } = createStorageAccess();

        // Hidden File Sync and Customisation Sync write hidden files this way.
        await expect(storageAccess.writeHiddenFileAuto(path, "{}")).resolves.toBe(false);
        await expect(storageAccess.writeHiddenFileAuto(path, new ArrayBuffer(2))).resolves.toBe(false);
        await expect(storageAccess.appendHiddenFile(path, "{}")).resolves.toBe(false);
        // An ordinary synchronised file whose path is a hidden one is written this way, whole or in parts.
        await expect(storageAccess.writeFileAuto(path, "{}").catch(() => false)).resolves.toBe(false);
        await expect(storageAccess.writeBinaryFileInParts(path, parts(), publication).catch(() => false)).resolves.toBe(
            false
        );

        expect(mutations(native)).toEqual([]);
    });

    it.each(KEYS_FILE_SPELLINGS)("removes %s by none of its routes", async (path) => {
        const { native, storageAccess } = createStorageAccess();

        await expect(storageAccess.removeHidden(path)).resolves.toBe(false);

        expect(native.remove).not.toHaveBeenCalled();
        expect(mutations(native)).toEqual([]);
    });

    it("writes and removes another hidden file as before", async () => {
        const { native, storageAccess } = createStorageAccess();

        await expect(storageAccess.writeHiddenFileAuto(OTHER_FILE, "{}")).resolves.toBe(true);
        await storageAccess.removeHidden(OTHER_FILE);

        expect(native.write).toHaveBeenCalledWith(OTHER_FILE, "{}", undefined);
        expect(native.remove).toHaveBeenCalledWith(OTHER_FILE);
    });
});

/**
 * An ordinary synchronised document takes the `writeFileAuto` route. Its path is not in the vault index and is not
 * Markdown, so it is written straight to the adapter. The alias rule stops it there when the path is a spelling of
 * a hidden location which no folder lists.
 *
 * Note: a document with a real dotted path (`.obsidian/...`) is accepted by Hidden File Sync's `isTargetFile` and
 * kept out of the plug-in folder by the hidden-path rule, not here; the alias rule only has to stop a NON-dotted
 * spelling of a hidden path, which is what this exercises.
 */
describe("an ordinary document through writeFileAuto", () => {
    function createSyntheticStorageAccess() {
        const files = createSyntheticVault();
        const app = files.app() as unknown as App;
        const storageAccessManager = new StorageAccessManager();
        const API = { addLog: vi.fn() };
        const setting = { currentSettings: () => ({ ...DEFAULT_SETTINGS }) };
        const vaultAccess = new FileAccessObsidian(
            app,
            {
                storageAccessManager,
                vaultService: {},
                settingService: setting,
                APIService: API,
                pathService: {},
            } as never,
            createTrustedReleaseKeysPathMatcher(PLUGIN_DIRECTORY)
        );
        const storageAccess = new ServiceFileAccessObsidian({
            API,
            setting,
            vault: {},
            appLifecycle: { onFirstInitialise: { addHandler: vi.fn() } },
            fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } },
            storageEventManager: {},
            storageAccessManager,
            vaultAccess,
        } as never);
        return { files, storageAccess };
    }

    it.each([
        "OBSIDI~1/plugins/obsidian-livesync/main.js",
        "OBSIDI~1/plugins/obsidian-livesync/trusted-release-keys.json",
        ".obsidian/plugins/obsidian-livesync/TRUSTE~1.JSO",
    ])("is refused when its path is the alias %s of a hidden location", async (aliasPath) => {
        const { files, storageAccess } = createSyntheticStorageAccess();
        const before = files.snapshot();

        // writeFileAuto rejects (adapterWrite throws); the caller handles the refusal.
        await expect(storageAccess.writeFileAuto(aliasPath, "replaced").catch(() => "refused")).resolves.toBe(
            "refused"
        );

        expect(files.changes()).toEqual([]);
        expect(files.snapshot()).toEqual(before);
    });

    it("writes an ordinary document whose path uses the names its folders list", async () => {
        const { files, storageAccess } = createSyntheticStorageAccess();

        await expect(storageAccess.writeFileAuto("notes/report.txt", "content")).resolves.toBe(true);

        expect(await files.read("notes/report.txt")).toBe("content");
    });
});
