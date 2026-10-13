import { type App } from "@/deps";
import { FileAccessBase, type FileAccessBaseDependencies } from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import { ObsidianFileSystemAdapter } from "./FileSystemAdapters/ObsidianFileSystemAdapter";

/**
 * Obsidian-specific implementation of FileAccessBase
 * Uses ObsidianFileSystemAdapter for platform-specific operations
 */
export class FileAccessObsidian extends FileAccessBase<ObsidianFileSystemAdapter> {
    /**
     * @param isWriteProtected Tells whether a path addresses a file which nothing may create, change or remove
     * through this access layer.
     */
    constructor(app: App, dependencies: FileAccessBaseDependencies, isWriteProtected: (path: string) => boolean) {
        const adapter = new ObsidianFileSystemAdapter(app, isWriteProtected);
        super(adapter, dependencies);
    }
}
