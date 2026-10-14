import { type App } from "@/deps";
import { FileAccessBase, type FileAccessBaseDependencies } from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import { ObsidianFileSystemAdapter } from "./FileSystemAdapters/ObsidianFileSystemAdapter";
import {
    noProtectedPathLinkGuard,
    type ProtectedPathLinkGuard,
} from "./FileSystemAdapters/protectedPathLinkGuard";

/**
 * Obsidian-specific implementation of FileAccessBase
 * Uses ObsidianFileSystemAdapter for platform-specific operations
 */
export class FileAccessObsidian extends FileAccessBase<ObsidianFileSystemAdapter> {
    /**
     * @param isWriteProtected Tells whether a path addresses a file which nothing may create, change or remove
     * through this access layer.
     * @param linkGuard Refuses a path which a symbolic link or junction resolves into a protected path. A no-op
     * where links cannot arise, such as on the mobile file system.
     * @param isRemoveProtected Tells whether a path may not be removed or renamed: the protected files and also the
     * plug-in's own directory and its ancestors, so a directory delete cannot take the plug-in's files with it.
     */
    constructor(
        app: App,
        dependencies: FileAccessBaseDependencies,
        isWriteProtected: (path: string) => boolean,
        linkGuard: ProtectedPathLinkGuard = noProtectedPathLinkGuard(),
        isRemoveProtected?: (path: string) => boolean
    ) {
        const adapter = new ObsidianFileSystemAdapter(app, isWriteProtected, linkGuard, isRemoveProtected);
        super(adapter, dependencies);
    }
}
