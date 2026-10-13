import { describe, expect, it, vi } from "vitest";

// The adapter's collaborators are not exercised here: this spec only checks that the manager hands the host's
// unload state to its base, so that events are left alone once the plug-in has unloaded.
vi.mock("./ObsidianStorageEventManagerAdapter", () => ({
    ObsidianStorageEventManagerAdapter: class {
        status = { updateStatus() {} };
        persistence = {};
        watch = {};
        typeGuard = {};
        converter = {};
    },
}));

import type ObsidianLiveSyncPlugin from "@/main";
import type { LiveSyncCore } from "@/main";
import { StorageEventManagerObsidian } from "./StorageEventManagerObsidian";

/** Reaches the base class's protected view of the unload state. */
class ExposedManager extends StorageEventManagerObsidian {
    get unloaded(): boolean {
        return this.hostUnloaded;
    }
}

function createManager(hasUnloaded: () => boolean) {
    const appLifecycle = { hasUnloaded };
    const core = { services: { appLifecycle } } as unknown as LiveSyncCore;
    const dependencies = {
        setting: {},
        vaultService: {},
        fileProcessing: {},
        storageAccessManager: {},
        APIService: { addLog: vi.fn() },
    } as never;
    return new ExposedManager({} as ObsidianLiveSyncPlugin, core, dependencies);
}

describe("StorageEventManagerObsidian", () => {
    it("hands the host's unload state to its base", () => {
        const state = { unloaded: false };
        const manager = createManager(() => state.unloaded);

        expect(manager.unloaded).toBe(false);
        state.unloaded = true;
        expect(manager.unloaded).toBe(true);
    });
});
