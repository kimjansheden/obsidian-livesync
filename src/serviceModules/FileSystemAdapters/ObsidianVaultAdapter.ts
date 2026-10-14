import type { UXDataWriteOptions } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { IVaultAdapter } from "@vrtmrz/livesync-commonlib/compat/serviceModules/adapters";
import { toArrayBuffer } from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import type { TFile, App, TFolder } from "obsidian";
import { toIntegerTimestamps } from "./sanitizeWriteOptions";
import { createPathAliasGuard, type PathAliasGuard } from "./pathAliasGuard";
import { noProtectedPathLinkGuard, type ProtectedPathLinkGuard } from "./protectedPathLinkGuard";

/**
 * Vault adapter implementation for Obsidian
 */
export class ObsidianVaultAdapter implements IVaultAdapter<TFile, TFolder> {
    /**
     * @param aliasGuard Refuses a path which reaches an existing entry by a name its folder does not list. A file
     * which the vault index holds is addressed by the name it is listed under; a path which is not in the index
     * yet, the one of a file to create or the target of a rename, is checked here.
     * @param linkGuard Refuses a write or rename target which a symbolic link or junction resolves into the
     * plug-in folder or its keys file. A no-op where links cannot arise (mobile).
     * @param isWriteProtected Tells whether a path addresses a file which nothing may write or rename to through
     * this adapter: this plug-in's own installed files, kept out of every synchronised write at this choke point as
     * on the storage adapter. The installer writes the raw host adapter directly, never this one.
     * @param isRemoveProtected Tells whether a path may not be renamed from or to: the protected files and also the
     * plug-in's own directory and its ancestors, so a rename cannot move or replace the plug-in with its files.
     * Defaults to {@link isWriteProtected}, which covers the files but no ancestor directory.
     */
    constructor(
        private app: App,
        private readonly aliasGuard: PathAliasGuard = createPathAliasGuard(app),
        private readonly linkGuard: ProtectedPathLinkGuard = noProtectedPathLinkGuard(),
        private readonly isWriteProtected: (path: string) => boolean = () => false,
        private readonly isRemoveProtected: (path: string) => boolean = isWriteProtected
    ) {}

    private async assertMayWrite(path: string): Promise<void> {
        if (this.isWriteProtected(path)) throw new Error("Refusing to change a write-protected file.");
        await this.linkGuard.assertNoLinkEscape(path);
    }

    /** A rename may neither move one of the protected paths away (its source) nor move or replace one (its target). */
    private assertMayRename(fromPath: string, toPath: string): void {
        if (this.isRemoveProtected(fromPath) || this.isRemoveProtected(toPath)) {
            throw new Error("Refusing to change a write-protected file.");
        }
    }

    async read(file: TFile): Promise<string> {
        // Vault.read strips a leading UTF-8 BOM, leaving the content size inconsistent with TFile.stat.
        return await this.app.vault.adapter.read(file.path);
    }

    async cachedRead(file: TFile): Promise<string> {
        return await this.app.vault.cachedRead(file);
    }

    async readBinary(file: TFile): Promise<ArrayBuffer> {
        return await this.app.vault.readBinary(file);
    }

    async modify(file: TFile, data: string, options?: UXDataWriteOptions): Promise<void> {
        await this.assertMayWrite(file.path);
        return await this.app.vault.modify(file, data, toIntegerTimestamps(options));
    }

    async modifyBinary(file: TFile, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        await this.assertMayWrite(file.path);
        return await this.app.vault.modifyBinary(file, toArrayBuffer(data), toIntegerTimestamps(options));
    }

    async create(path: string, data: string, options?: UXDataWriteOptions): Promise<TFile> {
        await this.assertMayWrite(path);
        await this.aliasGuard.assertNoAlias(path);
        return await this.app.vault.create(path, data, toIntegerTimestamps(options));
    }

    async createBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<TFile> {
        await this.assertMayWrite(path);
        await this.aliasGuard.assertNoAlias(path);
        return await this.app.vault.createBinary(path, toArrayBuffer(data), toIntegerTimestamps(options));
    }

    async rename(file: TFile, newPath: string): Promise<void> {
        this.assertMayRename(file.path, newPath);
        await this.linkGuard.assertNoLinkEscape(file.path);
        await this.aliasGuard.assertNoAlias(file.path);
        await this.linkGuard.assertNoLinkEscape(newPath);
        await this.aliasGuard.assertNoAlias(newPath);
        return await this.app.vault.rename(file, newPath);
    }

    private async assertMayRemove(path: string): Promise<void> {
        if (this.isRemoveProtected(path)) throw new Error("Refusing to change a write-protected file.");
        await this.linkGuard.assertNoLinkEscape(path);
        await this.aliasGuard.assertNoAlias(path);
    }

    async delete(file: TFile | TFolder): Promise<void> {
        await this.assertMayRemove(file.path);
        return await this.app.fileManager.trashFile(file);
    }

    async trash(file: TFile | TFolder): Promise<void> {
        await this.assertMayRemove(file.path);
        return await this.app.fileManager.trashFile(file);
    }

    trigger(name: string, ...data: unknown[]): void {
        return this.app.vault.trigger(name, ...data);
    }
}
