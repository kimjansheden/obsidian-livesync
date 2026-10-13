import { describe, expect, it, vi } from "vitest";

vi.mock("@/deps.ts", () => ({
    addIcon: vi.fn(),
    diff_match_patch: class DiffMatchPatch {},
    normalizePath: vi.fn((path: string) => path),
    parseYaml: vi.fn(),
    Platform: {},
}));
vi.mock("./PluginDialogModal.ts", () => ({
    PluginDialogModal: class PluginDialogModal {},
}));
vi.mock("@/features/HiddenFileCommon/JsonResolveModal.ts", () => ({
    JsonResolveModal: class JsonResolveModal {},
}));
vi.mock("@/modules/features/InteractiveConflictResolving/ConflictResolveModal.ts", () => ({
    ConflictResolveModal: class ConflictResolveModal {},
}));
// The path guard comes from the real LiveSyncCommands, so only its log view dependency is replaced.
vi.mock("@/modules/features/ModuleLog.ts", () => ({
    MARK_DONE: "",
}));
vi.mock("@/common/types.ts", () => ({
    ICXHeader: "ix:",
    PERIODIC_PLUGIN_SWEEP: 60,
}));
vi.mock("@/common/utils.ts", () => ({
    cancelTask: vi.fn(),
    EVEN: Symbol("even"),
    isCustomisationSyncMetadata: vi.fn(),
    isPluginMetadata: vi.fn(),
    scheduleTask: vi.fn(),
}));
vi.mock("@/common/PeriodicProcessor.ts", () => ({
    PeriodicProcessor: class PeriodicProcessor {},
}));
vi.mock("@/common/events.ts", () => ({
    EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG: "open-plugin-sync",
    eventHub: {
        onEvent: vi.fn(),
    },
}));
vi.mock("@/common/translation", () => ({
    $msg: vi.fn((message: string) => message),
}));
vi.mock("@/common/obsidianCommunityPlugins.ts", () => ({
    getObsidianCommunityPluginManager: vi.fn(() => ({ manifests: [], enabledPlugins: new Set() })),
}));

import type { FilePath, FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { ConfigSync, PluginDataExDisplayV2, type IPluginDataExDisplay } from "./CmdConfigSync";

const CONFIG_DIRECTORY = ".obsidian";
const PLUGIN_DIRECTORY = `${CONFIG_DIRECTORY}/plugins/obsidian-livesync`;
const KEYS_FILE = `${PLUGIN_DIRECTORY}/trusted-release-keys.json` as FilePath;
const KEYS_FILE_SPELLINGS = [
    KEYS_FILE,
    `${CONFIG_DIRECTORY}/plugins/obsidian-livesync/Trusted-Release-Keys.JSON`,
    `${CONFIG_DIRECTORY}/plugins/Obsidian-LiveSync/trusted-release-keys.json`,
    `${CONFIG_DIRECTORY}/plugins//obsidian-livesync/trusted-release-keys.json`,
] as FilePath[];
/** Another file in the same folder, which Customisation Sync handles as before. */
const OTHER_FILE = `${PLUGIN_DIRECTORY}/other.json` as FilePath;
/** This plug-in's own executable files, which installation owns; spellings a file system folds to them too. */
const OWN_EXECUTABLE_SPELLINGS = [
    `${PLUGIN_DIRECTORY}/main.js`,
    `${PLUGIN_DIRECTORY}/manifest.json`,
    `${PLUGIN_DIRECTORY}/styles.css`,
    `${CONFIG_DIRECTORY}/plugins/Obsidian-LiveSync/MAIN.JS`,
    `${CONFIG_DIRECTORY}/plugins/obsidian-livesync/manifest.json.`,
] as FilePath[];
/** Another plug-in's executable file, which Customisation Sync must still handle. */
const OTHER_PLUGIN_MAIN = `${CONFIG_DIRECTORY}/plugins/another-plugin/main.js` as FilePath;
/** The file name of a path as a customisation document states it: relative to the configuration folder. */
const filenameOf = (path: string) => path.slice(CONFIG_DIRECTORY.length + 1);

function setup() {
    const storageAccess = {
        statHidden: vi.fn(async () => ({ type: "file", ctime: 0, mtime: 1_000, size: 1 })),
        readHiddenFileBinary: vi.fn(async () => new ArrayBuffer(0)),
        readHiddenFileText: vi.fn(async () => "content on this device"),
        ensureDir: vi.fn(async () => true),
        writeHiddenFileAuto: vi.fn(async (..._args: unknown[]) => true),
    };
    const getDBEntry = vi.fn();
    // Obsidian adds Array.prototype.contains, which is not available under Node.
    const recentProcessedInternalFiles = Object.assign([] as string[], {
        contains: (key: string) => recentProcessedInternalFiles.includes(key),
    });
    const configSync = Object.create(ConfigSync.prototype) as ConfigSync;
    const storeCustomisationFileV2 = vi.spyOn(configSync, "storeCustomisationFileV2");
    Object.assign(configSync, {
        core: {
            // Every optional kind of file is synchronised, so only the guard under test can keep a file out.
            settings: { usePluginSync: true, usePluginSyncV2: true, usePluginEtc: true, pluginSyncExtendedSetting: {} },
            services: {
                appLifecycle: { isReady: () => true, isSuspended: () => false },
                API: { getSystemConfigDir: () => CONFIG_DIRECTORY },
                setting: { getDeviceAndVaultName: () => "synthetic-device" },
                context: {
                    plugin: {
                        manifest: { id: "obsidian-livesync", dir: PLUGIN_DIRECTORY },
                        app: { vault: { configDir: CONFIG_DIRECTORY } },
                    },
                },
            },
            storageAccess,
            localDatabase: { getDBEntry },
        },
        _log: vi.fn(),
        recentProcessedInternalFiles,
        storeCustomizationFiles: vi.fn(async () => undefined),
        updatePluginList: vi.fn(async () => undefined),
        filenameToUnifiedKey: (path: string) => `ix:${path}`,
        filenameWithUnifiedKey: (path: string) => `ix:${path}`,
        path2id: vi.fn(async (path: string) => path),
    });
    return { configSync, storageAccess, getDBEntry, storeCustomisationFileV2 };
}

/** A customisation document with one text file per path, as it arrives from another device. */
function receivedData(paths: string[]): PluginDataExDisplayV2 {
    return new PluginDataExDisplayV2({
        documentPath: "ix:synthetic" as FilePathWithPrefix,
        category: "PLUGIN_ETC",
        name: "synthetic",
        term: "other-device",
        files: paths.map((path) => ({
            filename: filenameOf(path),
            data: ["content from another device"],
            datatype: "plain",
            mtime: 2_000,
            ctime: 2_000,
        })),
    } as unknown as IPluginDataExDisplay);
}

describe("Customisation Sync and the trusted release keys: storing", () => {
    it("takes another file of the plug-in's folder for a file to store", () => {
        const { configSync } = setup();

        expect(configSync.getFileCategory(OTHER_FILE)).toBe("PLUGIN_ETC");
        expect(configSync.isTargetPath(OTHER_FILE)).toBe(true);
    });

    it.each(KEYS_FILE_SPELLINGS)("gives %s no category, so a scan does not select it", (path) => {
        const { configSync } = setup();

        expect(configSync.getFileCategory(path)).toBe("");
        expect(configSync.isTargetPath(path)).toBe(false);
    });

    it.each(KEYS_FILE_SPELLINGS)("does not read %s to store it", async (path) => {
        const { configSync, storageAccess } = setup();

        await expect(configSync.makeEntryFromFile(path)).resolves.toBe(false);
        await expect(configSync.storeCustomisationFileV2(path, "synthetic-device")).resolves.toBe(false);
        await expect(configSync.watchVaultRawEventsAsync(path)).resolves.toBe(false);

        expect(storageAccess.statHidden).not.toHaveBeenCalled();
        expect(storageAccess.readHiddenFileBinary).not.toHaveBeenCalled();
    });

    it("reads another file to store it", async () => {
        const { configSync, storageAccess } = setup();

        await configSync.makeEntryFromFile(OTHER_FILE);

        expect(storageAccess.statHidden).toHaveBeenCalledWith(OTHER_FILE);
    });
});

describe("Customisation Sync and the trusted release keys: applying", () => {
    it.each(KEYS_FILE_SPELLINGS)("does not write %s from a selected document", async (path) => {
        const { configSync, storageAccess } = setup();

        await expect(configSync.applyDataV2(receivedData([path]), "content chosen in the dialogue")).resolves.toBe(
            false
        );

        expect(storageAccess.ensureDir).not.toHaveBeenCalled();
        expect(storageAccess.writeHiddenFileAuto).not.toHaveBeenCalled();
    });

    it.each(KEYS_FILE_SPELLINGS)(
        "passes over %s among the files of a document, and applies the others",
        async (path) => {
            const { configSync, storageAccess, storeCustomisationFileV2 } = setup();
            storeCustomisationFileV2.mockResolvedValue(false);

            await configSync.applyDataV2(receivedData([path, OTHER_FILE]));

            expect(storageAccess.writeHiddenFileAuto).toHaveBeenCalledExactlyOnceWith(
                OTHER_FILE,
                "content from another device",
                { mtime: 2_000, ctime: 2_000 }
            );
            expect(storageAccess.ensureDir).toHaveBeenCalledExactlyOnceWith(OTHER_FILE);
            expect(storeCustomisationFileV2).not.toHaveBeenCalledWith(path, expect.anything());
        }
    );

    it.each(KEYS_FILE_SPELLINGS)("does not write %s from a document of the earlier format", async (path) => {
        const { configSync, storageAccess, getDBEntry } = setup();
        // The earlier format keeps the files of one item in a single document.
        getDBEntry.mockResolvedValue({
            data: [
                JSON.stringify({
                    files: [path, OTHER_FILE].map((file) => ({ filename: filenameOf(file), data: ["AAAA"] })),
                }),
            ],
        });
        const item = { documentPath: "ix:synthetic", name: "synthetic", category: "SNIPPET" };

        await configSync.applyData(item as unknown as IPluginDataExDisplay);

        expect(storageAccess.writeHiddenFileAuto).toHaveBeenCalledOnce();
        expect(storageAccess.writeHiddenFileAuto.mock.calls[0][0]).toBe(OTHER_FILE);
        expect(storageAccess.ensureDir).toHaveBeenCalledExactlyOnceWith(OTHER_FILE);
    });
});

describe("Customisation Sync and this plug-in's own executable files", () => {
    it.each(OWN_EXECUTABLE_SPELLINGS)("gives %s no category, so a scan does not select it", (path) => {
        const { configSync } = setup();

        expect(configSync.getFileCategory(path)).toBe("");
        expect(configSync.isTargetPath(path)).toBe(false);
    });

    it.each(OWN_EXECUTABLE_SPELLINGS)("does not read %s to store it", async (path) => {
        const { configSync, storageAccess } = setup();

        await expect(configSync.makeEntryFromFile(path)).resolves.toBe(false);
        await expect(configSync.storeCustomisationFileV2(path, "synthetic-device")).resolves.toBe(false);
        await expect(configSync.watchVaultRawEventsAsync(path)).resolves.toBe(false);

        expect(storageAccess.statHidden).not.toHaveBeenCalled();
        expect(storageAccess.readHiddenFileBinary).not.toHaveBeenCalled();
    });

    it.each(OWN_EXECUTABLE_SPELLINGS)("does not write %s from a selected document", async (path) => {
        const { configSync, storageAccess } = setup();

        await expect(configSync.applyDataV2(receivedData([path]), "content chosen in the dialogue")).resolves.toBe(
            false
        );

        expect(storageAccess.ensureDir).not.toHaveBeenCalled();
        expect(storageAccess.writeHiddenFileAuto).not.toHaveBeenCalled();
    });

    it("passes over this plug-in's main.js among a document's files, and applies another plug-in's file", async () => {
        const { configSync, storageAccess, storeCustomisationFileV2 } = setup();
        storeCustomisationFileV2.mockResolvedValue(false);

        await configSync.applyDataV2(receivedData([`${PLUGIN_DIRECTORY}/main.js` as FilePath, OTHER_PLUGIN_MAIN]));

        expect(storageAccess.writeHiddenFileAuto).toHaveBeenCalledExactlyOnceWith(
            OTHER_PLUGIN_MAIN,
            "content from another device",
            { mtime: 2_000, ctime: 2_000 }
        );
    });

    it("still categorises and synchronises another plug-in's executable files", () => {
        const { configSync } = setup();

        expect(configSync.getFileCategory(OTHER_PLUGIN_MAIN)).toBe("PLUGIN_MAIN");
        expect(configSync.isTargetPath(OTHER_PLUGIN_MAIN)).toBe(true);
    });
});
