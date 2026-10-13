import type { FilePath } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type ObsidianLiveSyncPlugin from "@/main";
import type { LiveSyncCore } from "@/main";
import { StorageEventManagerBase, type StorageEventManagerBaseDependencies } from "@vrtmrz/livesync-commonlib/compat/managers/StorageEventManager";
import { ObsidianStorageEventManagerAdapter } from "./ObsidianStorageEventManagerAdapter";

export class StorageEventManagerObsidian extends StorageEventManagerBase<ObsidianStorageEventManagerAdapter> {
    core: LiveSyncCore;

    // Necessary evil.
    // cmdHiddenFileSync: HiddenFileSync;

    constructor(plugin: ObsidianLiveSyncPlugin, core: LiveSyncCore, dependencies: StorageEventManagerBaseDependencies) {
        const adapter = new ObsidianStorageEventManagerAdapter(plugin, core, dependencies.fileProcessing);
        // Events which arrive, or are still queued, after the plug-in has unloaded are left to the next start.
        super(adapter, { ...dependencies, appLifecycle: core.services.appLifecycle });
        this.core = core;
    }

    /**
     * Override _watchVaultRawEvents to add Obsidian-specific logic
     */
    protected override async _watchVaultRawEvents(path: FilePath) {
        if (!this.settings.syncInternalFiles && !this.settings.usePluginSync) return;
        if (!this.settings.watchInternalFileChanges) return;
        if (!path.startsWith(this.core.services.API.getSystemConfigDir())) return;
        if (path.endsWith("/")) {
            // Folder
            return;
        }
        const isTargetFile = await this.vaultService.isTargetFileInExtra(path);
        if (!isTargetFile) return;

        void this.appendQueue(
            [
                {
                    type: "INTERNAL",
                    file: this.adapter.converter.toInternalFileInfo(path),
                    skipBatchWait: true, // Internal files should be processed immediately.
                },
            ],
            null
        );
    }
}
