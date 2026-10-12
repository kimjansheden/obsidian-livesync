import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { paneSyncSettings } from "./PaneSyncSettings.ts";

type ToggleOptions = { onUpdate?: () => { visibility?: boolean } };
const settingHarness = vi.hoisted(() => ({
    toggles: new Map<string, { onUpdate?: () => { visibility?: boolean } } | undefined>(),
}));

vi.mock("./LiveSyncSetting.ts", () => ({
    // Every other call on a setting returns the setting, as the calls are chained.
    LiveSyncSetting: class LiveSyncSetting {
        constructor() {
            const setting: object = new Proxy(this, {
                get: (_target, property) => {
                    if (property === "settingEl") return { createDiv: () => ({}) };
                    if (property === "autoWireToggle") {
                        return (key: string, options?: ToggleOptions) => {
                            settingHarness.toggles.set(key, options);
                            return setting;
                        };
                    }
                    return () => setting;
                },
            });
            return setting;
        }
    },
}));

afterEach(() => {
    settingHarness.toggles.clear();
});

/** Render the pane for a device, and wait until its panels have been filled. */
async function renderPane(device: { remoteType: string; isMobile: boolean }) {
    const panel = { createDiv: vi.fn(() => ({})) } as unknown as HTMLElement;
    const addPanel = vi.fn(() => Promise.resolve(panel));
    const editingSettings = { remoteType: device.remoteType, syncInternalFiles: false };
    const host = {
        editingSettings,
        isConfiguredAs: (key: keyof typeof editingSettings, value: unknown) => editingSettings[key] === value,
        addOnSaved: vi.fn(),
        requestCatalogueRefresh: vi.fn(),
        services: { API: { isMobile: () => device.isMobile } },
    };

    paneSyncSettings.call(host as never, {} as HTMLElement, { addPanel } as never);
    await vi.waitFor(() => expect(settingHarness.toggles.has("allowSleepDuringSynchronisation")).toBe(true));
    return settingHarness.toggles;
}

describe("paneSyncSettings removal of the content of deleted files from the remote", () => {
    it.each([
        ["a desktop device", false],
        ["a mobile device", true],
    ])("offers the setting on %s with an Object Storage remote", async (_device, isMobile) => {
        const toggles = await renderPane({ remoteType: REMOTE_MINIO, isMobile });

        expect(toggles.has("removeUnreferencedJournalData")).toBe(true);
        expect(toggles.get("removeUnreferencedJournalData")?.onUpdate?.()).toEqual({ visibility: true });
    });

    it.each([
        ["CouchDB", REMOTE_COUCHDB],
        ["peer-to-peer", REMOTE_P2P],
    ])("hides the setting with a %s remote", async (_name, remoteType) => {
        const toggles = await renderPane({ remoteType, isMobile: false });

        expect(toggles.get("removeUnreferencedJournalData")?.onUpdate?.()).toEqual({ visibility: false });
    });
});
