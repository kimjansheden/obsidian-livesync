import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB } from "@vrtmrz/livesync-commonlib/compat/common/types";

const negotiationMocks = vi.hoisted(() => ({
    checkSyncInfo: vi.fn(async () => true),
}));
const settingsInitialisationMocks = vi.hoisted(() => ({
    applySettingsWithInitialisationChoice: vi.fn(),
}));

vi.mock("@/deps.ts", () => ({
    App: class {},
    Component: class {
        load = vi.fn();
        unload = vi.fn();
        register = vi.fn();
    },
    PluginSettingTab: class {},
    SettingPage: undefined,
    requireApiVersion: vi.fn(() => false),
}));
vi.mock("@/main.ts", () => ({ default: class {} }));
vi.mock("@vrtmrz/livesync-commonlib/compat/common/coreEnvFunctions", () => ({
    getLanguage: vi.fn(() => "en"),
    compatGlobal: {
        localStorage: {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
        },
    },
}));
vi.mock("@/common/events.ts", () => ({
    EVENT_ON_UNRESOLVED_ERROR: "on-unresolved-error",
    EVENT_REQUEST_COPY_SETUP_URI: "request-copy-setup-uri",
    EVENT_REQUEST_OPEN_SETUP_URI: "request-open-setup-uri",
    EVENT_REQUEST_RELOAD_SETTING_TAB: "request-reload-setting-tab",
    EVENT_REQUEST_SHOW_SETUP_QR: "request-show-setup-qr",
    eventHub: { emitEvent: vi.fn(), onEvent: vi.fn() },
}));
vi.mock("@/modules/features/SetupManager.ts", () => ({ SetupManager: class {} }));
vi.mock("@vrtmrz/livesync-commonlib/compat/pouchdb/negotiation", () => negotiationMocks);
vi.mock("@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator", () => ({
    LiveSyncCouchDBReplicator: class {},
}));
vi.mock("./LiveSyncSetting.ts", () => ({ LiveSyncSetting: class {} }));
vi.mock("./SettingPane.ts", () => ({
    enableOnly: vi.fn(() => vi.fn()),
    setLevelClass: vi.fn(),
    setStyle: vi.fn(),
    visibleOnly: vi.fn(() => vi.fn()),
}));
vi.mock("./PaneChangeLog.ts", () => ({ paneChangeLog: vi.fn() }));
vi.mock("./PaneQuickSetup.ts", () => ({ paneQuickSetup: vi.fn() }));
vi.mock("./PaneHelp.ts", () => ({ paneHelp: vi.fn() }));
vi.mock("./PaneGeneral.ts", () => ({ paneGeneral: vi.fn() }));
vi.mock("./PaneRemoteConfig.ts", () => ({ paneRemoteConfig: vi.fn() }));
vi.mock("./PaneSelector.ts", () => ({ paneSelector: vi.fn() }));
vi.mock("./PaneSyncSettings.ts", () => ({ paneSyncSettings: vi.fn() }));
vi.mock("./PaneCustomisationSync.ts", () => ({ paneCustomisationSync: vi.fn() }));
vi.mock("./PaneHatch.ts", () => ({ paneHatch: vi.fn() }));
vi.mock("./PaneAdvanced.ts", () => ({ paneAdvanced: vi.fn() }));
vi.mock("./PanePowerUsers.ts", () => ({ panePowerUsers: vi.fn() }));
vi.mock("./PanePatches.ts", () => ({ panePatches: vi.fn() }));
vi.mock("./PaneMaintenance.ts", () => ({ paneMaintenance: vi.fn() }));

import { LiveSyncCouchDBReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator";
import { ObsidianLiveSyncSettingTab } from "./ObsidianLiveSyncSettingTab";

beforeEach(() => {
    settingsInitialisationMocks.applySettingsWithInitialisationChoice.mockReset();
});

describe("ObsidianLiveSyncSettingTab passphrase verification", () => {
    it("closes the finite remote connection after checking synchronisation information", async () => {
        const remoteDatabase = {
            close: vi.fn(async () => undefined),
        };
        const replicator = Object.assign(new LiveSyncCouchDBReplicator({} as never), {
            connectRemoteCouchDBWithSetting: vi.fn(async () => ({ db: remoteDatabase })),
        });
        const plugin = {
            app: {},
            core: {
                services: {
                    API: { isMobile: vi.fn(() => false) },
                    replicator: { getNewReplicator: vi.fn(() => replicator) },
                },
            },
        };
        const tab = new ObsidianLiveSyncSettingTab({} as never, plugin as never);
        Object.assign(tab, {
            _editingSettings: {
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_COUCHDB,
            },
        });

        await expect(tab.checkWorkingPassphrase()).resolves.toBe(true);

        expect(negotiationMocks.checkSyncInfo).toHaveBeenCalledWith(remoteDatabase);
        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });
});

describe("ObsidianLiveSyncSettingTab pending-setting initialisation", () => {
    function createSettingsTab() {
        const saveSettingData = vi.fn(async () => undefined);
        const confirmWithMessage = vi.fn();
        const plugin = {
            app: {},
            core: {
                settings: {
                    ...DEFAULT_SETTINGS,
                    handleFilenameCaseSensitive: false,
                },
                getModule: vi.fn(() => settingsInitialisationMocks),
                confirm: {
                    confirmWithMessage,
                },
                services: {
                    setting: {
                        saveSettingData,
                        getDeviceAndVaultName: vi.fn(() => ""),
                    },
                },
            },
        };
        const tab = new ObsidianLiveSyncSettingTab({} as never, plugin as never);
        Object.assign(tab, {
            _editingSettings: {
                ...DEFAULT_SETTINGS,
                handleFilenameCaseSensitive: true,
            },
            initialSettings: {
                ...DEFAULT_SETTINGS,
                handleFilenameCaseSensitive: false,
            },
        });
        vi.spyOn(tab, "isPassphraseValid").mockResolvedValue(true);
        vi.spyOn(tab, "checkWorkingPassphrase").mockResolvedValue(true);
        const closeSetting = vi.spyOn(tab, "closeSetting").mockImplementation(() => undefined);
        return { tab, saveSettingData, confirmWithMessage, closeSetting };
    }

    it("keeps pending settings in the editing buffer when initialisation and the fallback are cancelled", async () => {
        const { tab, saveSettingData, confirmWithMessage, closeSetting } = createSettingsTab();
        settingsInitialisationMocks.applySettingsWithInitialisationChoice.mockResolvedValueOnce({
            result: "cancelled",
        });
        confirmWithMessage.mockResolvedValueOnce("Keep Editing");

        await tab.confirmRebuild();

        expect(settingsInitialisationMocks.applySettingsWithInitialisationChoice).toHaveBeenCalledOnce();
        expect(confirmWithMessage).toHaveBeenCalledWith(
            "Apply Settings without Initialisation?",
            expect.any(String),
            ["Apply without Initialisation", "Keep Editing"],
            "Keep Editing"
        );
        expect(saveSettingData).not.toHaveBeenCalled();
        expect(tab.editingSettings.handleFilenameCaseSensitive).toBe(true);
        expect(tab.core.settings.handleFilenameCaseSensitive).toBe(false);
        expect(closeSetting).not.toHaveBeenCalled();
    });

    it("applies pending settings only after a separately confirmed initialisation bypass", async () => {
        const { tab, saveSettingData, confirmWithMessage, closeSetting } = createSettingsTab();
        settingsInitialisationMocks.applySettingsWithInitialisationChoice.mockResolvedValueOnce({
            result: "cancelled",
        });
        confirmWithMessage.mockResolvedValueOnce("Apply without Initialisation");

        await tab.confirmRebuild();

        expect(settingsInitialisationMocks.applySettingsWithInitialisationChoice).toHaveBeenCalledOnce();
        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(tab.core.settings.handleFilenameCaseSensitive).toBe(true);
        expect(closeSetting).not.toHaveBeenCalled();
    });

    it("closes settings only after initialisation has been scheduled", async () => {
        const { tab, saveSettingData, confirmWithMessage, closeSetting } = createSettingsTab();
        settingsInitialisationMocks.applySettingsWithInitialisationChoice.mockImplementationOnce(
            async ({ applySettings }: { applySettings: () => Promise<void> }) => {
                await applySettings();
                return { result: "scheduled", mode: "rebuild" };
            }
        );

        await tab.confirmRebuild();

        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(confirmWithMessage).not.toHaveBeenCalled();
        expect(closeSetting).toHaveBeenCalledOnce();
    });

    it("does not offer the settings-only fallback after an initialisation failure", async () => {
        const { tab, saveSettingData, confirmWithMessage, closeSetting } = createSettingsTab();
        settingsInitialisationMocks.applySettingsWithInitialisationChoice.mockResolvedValueOnce({
            result: "failed",
            mode: "fetch",
        });

        await tab.confirmRebuild();

        expect(saveSettingData).not.toHaveBeenCalled();
        expect(confirmWithMessage).not.toHaveBeenCalled();
        expect(tab.editingSettings.handleFilenameCaseSensitive).toBe(true);
        expect(tab.core.settings.handleFilenameCaseSensitive).toBe(false);
        expect(closeSetting).not.toHaveBeenCalled();
    });
});

describe("ObsidianLiveSyncSettingTab declarative settings boundary", () => {
    function createSettingsTab() {
        const saveSettingData = vi.fn(async () => undefined);
        const clearUsedPassphrase = vi.fn();
        const askString = vi.fn(async (..._args: unknown[]): Promise<string | false> => false);
        const setting = {
            saveSettingData,
            clearUsedPassphrase,
            getPassphrase: vi.fn(async (..._args: unknown[]): Promise<string | false> => "*"),
            getDeviceAndVaultName: vi.fn(() => ""),
        };
        const plugin = {
            app: {},
            core: {
                settings: {
                    ...DEFAULT_SETTINGS,
                    hashCacheMaxCount: 300,
                    displayLanguage: "",
                },
                confirm: { askString },
                services: {
                    setting,
                },
            },
        };
        Object.defineProperty(plugin, "settings", {
            get: () => {
                throw new Error("The declarative adapter must not use plugin.settings");
            },
        });
        const tab = new ObsidianLiveSyncSettingTab({} as never, plugin as never);
        Object.assign(tab, {
            _editingSettings: {
                ...DEFAULT_SETTINGS,
                hashCacheMaxCount: 300,
                displayLanguage: "",
            },
            initialSettings: {
                ...DEFAULT_SETTINGS,
                hashCacheMaxCount: 300,
                displayLanguage: "",
            },
        });
        return { tab, saveSettingData, clearUsedPassphrase, askString, setting, core: plugin.core };
    }

    it("asks for a launch passphrase twice and saves with the confirmed answer", async () => {
        const { tab, saveSettingData, clearUsedPassphrase, askString, setting } = createSettingsTab();
        askString
            .mockResolvedValueOnce("synthetic-launch-passphrase")
            .mockResolvedValueOnce("synthetic-launch-passphrase");
        const askAtSave = setting.getPassphrase;
        let passphraseDuringSave: string | false | undefined;
        saveSettingData.mockImplementationOnce(async () => {
            passphraseDuringSave = await setting.getPassphrase();
            return undefined;
        });
        tab.editingSettings.configPassphraseStore = "ASK_AT_LAUNCH";

        await tab.saveSettings(["configPassphraseStore"]);

        expect(askString).toHaveBeenCalledTimes(2);
        expect(clearUsedPassphrase).toHaveBeenCalledOnce();
        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(passphraseDuringSave).toBe("synthetic-launch-passphrase");
        expect(setting.getPassphrase).toBe(askAtSave);
    });

    it("keeps the previous passphrase mode when the launch passphrase is not confirmed", async () => {
        const { tab, saveSettingData, clearUsedPassphrase, askString, core } = createSettingsTab();
        askString
            .mockResolvedValueOnce("synthetic-launch-passphrase")
            .mockResolvedValueOnce("synthetic-launch-passphrasf");
        tab.editingSettings.configPassphraseStore = "ASK_AT_LAUNCH";

        await tab.saveSettings(["configPassphraseStore"]);

        expect(saveSettingData).not.toHaveBeenCalled();
        expect(clearUsedPassphrase).not.toHaveBeenCalled();
        expect(core.settings.configPassphraseStore).toBe("");
        expect(tab.editingSettings.configPassphraseStore).toBe("");
    });

    it("does not apply the launch passphrase mode while the passphrase is being confirmed", async () => {
        const { tab, askString, core } = createSettingsTab();
        const modesDuringPrompt: string[] = [];
        askString.mockImplementation(async () => {
            modesDuringPrompt.push(core.settings.configPassphraseStore);
            return "synthetic-launch-passphrase";
        });
        tab.editingSettings.configPassphraseStore = "ASK_AT_LAUNCH";

        await tab.saveSettings(["configPassphraseStore"]);

        expect(modesDuringPrompt).toEqual(["", ""]);
        expect(core.settings.configPassphraseStore).toBe("ASK_AT_LAUNCH");
    });

    it("still saves other settings when the launch passphrase is cancelled", async () => {
        const { tab, saveSettingData, clearUsedPassphrase, askString, core } = createSettingsTab();
        askString.mockResolvedValueOnce(false);
        tab.editingSettings.configPassphraseStore = "ASK_AT_LAUNCH";
        tab.editingSettings.hashCacheMaxCount = 321;

        await tab.saveSettings(["configPassphraseStore", "hashCacheMaxCount"]);

        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(clearUsedPassphrase).not.toHaveBeenCalled();
        expect(core.settings.hashCacheMaxCount).toBe(321);
        expect(core.settings.configPassphraseStore).toBe("");
        expect(tab.editingSettings.configPassphraseStore).toBe("");
    });

    it("re-encrypts data.json with the new store when the configuration passphrase mode changes", async () => {
        const { tab, saveSettingData, clearUsedPassphrase } = createSettingsTab();
        tab.editingSettings.configPassphraseStore = "LOCALSTORAGE";
        tab.editingSettings.configPassphrase = "synthetic-device-passphrase";

        await tab.saveSettings(["configPassphrase", "configPassphraseStore"]);

        expect(clearUsedPassphrase).toHaveBeenCalledOnce();
        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(clearUsedPassphrase.mock.invocationCallOrder[0]).toBeLessThan(
            saveSettingData.mock.invocationCallOrder[0]
        );
    });

    it("re-encrypts data.json when only the device-local configuration passphrase changes", async () => {
        const { tab, saveSettingData, clearUsedPassphrase } = createSettingsTab();
        tab.editingSettings.configPassphrase = "synthetic-new-device-passphrase";

        await tab.saveSettings(["configPassphrase"]);

        expect(clearUsedPassphrase).toHaveBeenCalledOnce();
        expect(saveSettingData).toHaveBeenCalledOnce();
    });

    it("keeps the used passphrase when other settings are saved", async () => {
        const { tab, saveSettingData, clearUsedPassphrase } = createSettingsTab();
        tab.editingSettings.hashCacheMaxCount = 321;

        await tab.saveSettings(["hashCacheMaxCount"]);

        expect(saveSettingData).toHaveBeenCalledOnce();
        expect(clearUsedPassphrase).not.toHaveBeenCalled();
    });

    it("loads the imperative fallback without a SettingPage runtime export", () => {
        const { tab } = createSettingsTab();

        expect(tab.display).toBeTypeOf("function");
        expect(tab.getSettingDefinitions()).toEqual([]);
    });

    it("reads and writes registered controls through the editing buffer and existing save owner", async () => {
        const { tab } = createSettingsTab();
        const saveSettings = vi.spyOn(tab, "saveSettings").mockResolvedValue(undefined);

        expect(tab.getControlValue("hashCacheMaxCount")).toBe(300);

        await tab.setControlValue("hashCacheMaxCount", 321);

        expect(tab.editingSettings.hashCacheMaxCount).toBe(321);
        expect(saveSettings).toHaveBeenCalledOnce();
        expect(saveSettings).toHaveBeenCalledWith(["hashCacheMaxCount"]);
    });

    it("rejects unregistered declarative control keys", async () => {
        const { tab } = createSettingsTab();

        expect(() => tab.getControlValue("couchDB_PASSWORD")).toThrow(/Unknown declarative setting key/u);
        await expect(tab.setControlValue("couchDB_PASSWORD", "secret")).rejects.toThrow(
            /Unknown declarative setting key/u
        );
    });

    it("rejects declarative values outside the registered control contract", async () => {
        const { tab } = createSettingsTab();
        const saveSettings = vi.spyOn(tab, "saveSettings").mockResolvedValue(undefined);

        await expect(tab.setControlValue("hashCacheMaxCount", 9)).rejects.toThrow(
            /Invalid value for declarative setting/u
        );
        await expect(tab.setControlValue("chunkSplitterVersion", "unknown-splitter")).rejects.toThrow(
            /Invalid value for declarative setting/u
        );

        expect(saveSettings).not.toHaveBeenCalled();
    });

    it("replaces a saved-setting handler when a page is rendered again", async () => {
        const { tab } = createSettingsTab();
        const first = vi.fn();
        const replacement = vi.fn();
        tab.addOnSaved("displayLanguage", first);
        tab.addOnSaved("displayLanguage", replacement);
        tab.editingSettings.displayLanguage = "ja";

        await tab.saveSettings(["displayLanguage"]);

        expect(first).not.toHaveBeenCalled();
        expect(replacement).toHaveBeenCalledOnce();
    });
});
