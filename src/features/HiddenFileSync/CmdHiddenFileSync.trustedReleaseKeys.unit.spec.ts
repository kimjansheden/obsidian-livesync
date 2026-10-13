import { describe, expect, it, vi } from "vitest";
import type {
    DocumentID,
    FilePath,
    FilePathWithPrefix,
    LoadedEntry,
} from "@vrtmrz/livesync-commonlib/compat/common/types";

vi.mock("@/deps.ts", () => ({}));
vi.mock("@/features/HiddenFileCommon/JsonResolveModal.ts", () => ({
    JsonResolveModal: class JsonResolveModal {},
}));
// The path guard comes from the real LiveSyncCommands, so only its log view dependency is replaced.
vi.mock("@/modules/features/ModuleLog.ts", () => ({
    MARK_DONE: "",
}));
vi.mock("./configureHiddenFileSyncMode.ts", () => ({
    configureHiddenFileSyncMode: vi.fn(),
}));

import { HiddenFileSync } from "./CmdHiddenFileSync.ts";

const PLUGIN_DIRECTORY = ".obsidian/plugins/obsidian-livesync";
const KEYS_FILE = `${PLUGIN_DIRECTORY}/trusted-release-keys.json` as FilePath;
const KEYS_FILE_SPELLINGS = [
    KEYS_FILE,
    ".obsidian/plugins/obsidian-livesync/Trusted-Release-Keys.JSON",
    ".Obsidian/Plugins/Obsidian-LiveSync/trusted-release-keys.json",
    ".obsidian/plugins//obsidian-livesync/trusted-release-keys.json",
] as FilePath[];
/** Another file in the same folder, which Hidden File Sync handles as before. */
const OTHER_FILE = `${PLUGIN_DIRECTORY}/data.json` as FilePath;

const documentOf = (path: FilePath) =>
    ({ _id: `i:${path.toLowerCase()}` as DocumentID, path: `i:${path}` as FilePathWithPrefix }) as LoadedEntry;

function createHiddenFileSync() {
    const lifecycle = { unloaded: false };
    const isIgnoredByIgnoreFile = vi.fn(async () => false);
    const statHidden = vi.fn(async () => null);
    const storageAccess = {
        statHidden,
        writeHiddenFileAuto: vi.fn(async () => true),
        removeHidden: vi.fn(async () => true),
        ensureDir: vi.fn(async () => true),
    };
    const processReplicationResult = vi.fn(async () => true);
    const hiddenFileSync = Object.create(HiddenFileSync.prototype) as HiddenFileSync;
    Object.assign(hiddenFileSync, {
        core: {
            settings: { syncInternalFiles: true },
            services: {
                appLifecycle: { hasUnloaded: () => lifecycle.unloaded },
                vault: { isIgnoredByIgnoreFile },
                path: { getPath: (entry: { path: string }) => entry.path },
                context: {
                    plugin: {
                        manifest: { id: "obsidian-livesync", dir: PLUGIN_DIRECTORY },
                        app: { vault: { configDir: ".obsidian" } },
                    },
                },
            },
            storageAccess,
        },
        _log: vi.fn(),
        // Every pattern lets the file through, so only the guard under test can keep it out.
        isTargetFileInPatterns: () => true,
        isNotIgnoredByCustomisationSync: () => true,
        processReplicationResult,
    });
    return { hiddenFileSync, lifecycle, isIgnoredByIgnoreFile, statHidden, storageAccess, processReplicationResult };
}

describe("Hidden File Sync and the trusted release keys", () => {
    it("handles another file of the plug-in's folder as before", async () => {
        const { hiddenFileSync, isIgnoredByIgnoreFile, processReplicationResult } = createHiddenFileSync();

        await expect(hiddenFileSync.isTargetFile(OTHER_FILE)).resolves.toBe(true);
        await expect(hiddenFileSync._anyProcessOptionalSyncFiles(documentOf(OTHER_FILE))).resolves.toBe(true);

        expect(isIgnoredByIgnoreFile).toHaveBeenCalledWith(OTHER_FILE);
        expect(processReplicationResult).toHaveBeenCalledOnce();
    });

    it.each(KEYS_FILE_SPELLINGS)("does not take %s for a file to store", async (path) => {
        const { hiddenFileSync, isIgnoredByIgnoreFile, statHidden } = createHiddenFileSync();

        await expect(hiddenFileSync.isTargetFile(path)).resolves.toBe(false);
        await expect(hiddenFileSync.trackStorageFileModification(path)).resolves.toBe(false);

        expect(isIgnoredByIgnoreFile).not.toHaveBeenCalled();
        expect(statHidden).not.toHaveBeenCalled();
    });

    it.each(KEYS_FILE_SPELLINGS)("does not write %s from a received document", async (path) => {
        const { hiddenFileSync, processReplicationResult, storageAccess } = createHiddenFileSync();

        // The document is a hidden-file document, so it counts as handled, but nothing is done with it.
        await expect(hiddenFileSync._anyProcessOptionalSyncFiles(documentOf(path))).resolves.toBe(true);

        expect(processReplicationResult).not.toHaveBeenCalled();
        expect(storageAccess.writeHiddenFileAuto).not.toHaveBeenCalled();
    });

    it.each(KEYS_FILE_SPELLINGS)("neither writes nor removes %s when a database entry is extracted", async (path) => {
        const { hiddenFileSync, isIgnoredByIgnoreFile, storageAccess } = createHiddenFileSync();

        await expect(hiddenFileSync.extractInternalFileFromDatabase(path, true)).resolves.toBeUndefined();

        // It ends before anything is looked up.
        expect(isIgnoredByIgnoreFile).not.toHaveBeenCalled();
        expect(storageAccess.ensureDir).not.toHaveBeenCalled();
        expect(storageAccess.writeHiddenFileAuto).not.toHaveBeenCalled();
        expect(storageAccess.removeHidden).not.toHaveBeenCalled();
    });
});

describe("Hidden File Sync after the plug-in has unloaded", () => {
    it("does not apply a received hidden-file document", async () => {
        const { hiddenFileSync, lifecycle, processReplicationResult } = createHiddenFileSync();
        lifecycle.unloaded = true;

        await expect(hiddenFileSync._anyProcessOptionalSyncFiles(documentOf(OTHER_FILE))).resolves.toBe(true);

        expect(processReplicationResult).not.toHaveBeenCalled();
    });

    it("does not extract a database entry to storage", async () => {
        const { hiddenFileSync, lifecycle, isIgnoredByIgnoreFile, storageAccess } = createHiddenFileSync();
        lifecycle.unloaded = true;

        await expect(hiddenFileSync.extractInternalFileFromDatabase(OTHER_FILE, true)).resolves.toBeUndefined();

        expect(isIgnoredByIgnoreFile).not.toHaveBeenCalled();
        expect(storageAccess.writeHiddenFileAuto).not.toHaveBeenCalled();
        expect(storageAccess.removeHidden).not.toHaveBeenCalled();
    });
});
