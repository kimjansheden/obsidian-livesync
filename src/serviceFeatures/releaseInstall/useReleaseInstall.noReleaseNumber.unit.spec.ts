import { describe, expect, it, vi } from "vitest";

// A build which does not know its own release number (the marker was absent or malformed) cannot tell which
// package is newer, so the feature must stay off. The running-release module is mocked to such a build here.
vi.mock("./runningRelease", () => ({
    RUNNING_RELEASE_NUMBER: 0,
    RELEASE_MARKER_PREFIX: "livesync-security-release:",
}));

import type { App, PluginManifest } from "obsidian";
import { useReleaseInstall, type ReleaseInstallHostBindings } from "./useReleaseInstall";

type Handler = () => Promise<boolean>;

describe("release install in a build which carries no release number", () => {
    it("is off, reads no trusted-keys file, and says so in the log", async () => {
        const settingLoaded: Handler[] = [];
        const layoutReady: Handler[] = [];
        const exists = vi.fn(async () => true);
        const readBinary = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
        const logs: string[] = [];
        const services = {
            API: { addLog: (message: unknown) => void logs.push(String(message)), isMobile: () => false },
            appLifecycle: {
                onSettingLoaded: { addHandler: (handler: Handler) => void settingLoaded.push(handler) },
                onLayoutReady: { addHandler: (handler: Handler) => void layoutReady.push(handler) },
                isReady: () => true,
            },
            control: { hasUnloaded: () => false },
            fileProcessing: {},
            replication: {},
            replicator: {},
        };
        const plugin = {
            app: { vault: { adapter: { exists, readBinary }, configDir: ".obsidian" } } as unknown as App,
            manifest: { id: "obsidian-livesync", dir: ".obsidian/plugins/obsidian-livesync" } as PluginManifest,
            registerEvent: vi.fn(),
            register: vi.fn(),
        };
        const bindings: ReleaseInstallHostBindings = {
            showNotice: vi.fn(),
            reportLoadedMainJs: vi.fn(),
            waitForTeardown: () => Promise.resolve(),
            isAppHidden: () => false,
            deviceLocalStorage: () => ({ load: () => undefined, save: () => undefined }),
        };

        useReleaseInstall({ services } as never, plugin as never, bindings);
        for (const handler of settingLoaded) expect(await handler()).toBe(true);
        for (const handler of layoutReady) expect(await handler()).toBe(true);

        expect(logs[logs.length - 1]).toContain("off (this build carries no release number)");
        // The trust file is never read, and nothing watches the vault.
        expect(exists).not.toHaveBeenCalled();
        expect(plugin.app.vault.on).toBeUndefined();
        expect(plugin.registerEvent).not.toHaveBeenCalled();
    });
});
