import { StagedBinaryPublication } from "./stagedBinaryPublication";
import type { BinaryPublication } from "@vrtmrz/livesync-commonlib/compat/interfaces/StorageAccess";
import type { UXDataWriteOptions } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { IStorageAdapter } from "@vrtmrz/livesync-commonlib/compat/serviceModules/adapters";
import { toArrayBuffer } from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import type { Stat, App } from "obsidian";
import { toIntegerTimestamps } from "./sanitizeWriteOptions";
import { createPathAliasGuard, type PathAliasGuard } from "./pathAliasGuard";

function assertVaultRelativePath(path: string, allowRoot = false): void {
    const unsafe =
        typeof path !== "string" ||
        path.includes("\0") ||
        path.includes("\\") ||
        path.startsWith("/") ||
        /^[A-Za-z]:/u.test(path) ||
        path.split("/").some((segment) => segment === "." || segment === "..");
    if (unsafe || (!allowRoot && path.length === 0)) {
        throw new Error("Refusing an unsafe vault-relative path.");
    }
}

/**
 * Storage adapter implementation for Obsidian
 */

export class ObsidianStorageAdapter implements IStorageAdapter<Stat> {
    private readonly staged: StagedBinaryPublication;
    /**
     * @param isWriteProtected Tells whether a path addresses a file which nothing may create, change or remove
     * through this adapter. Every writer and remover of synchronised content ends here, so this is where the file
     * of trusted release keys is kept out of their reach.
     * @param aliasGuard Refuses a path which reaches an existing entry by a name its folder does not list, so that
     * the rules which decide by the spelling of a path hold for the name the file system uses.
     */
    constructor(
        private app: App,
        private readonly isWriteProtected: (path: string) => boolean = () => false,
        private readonly aliasGuard: PathAliasGuard = createPathAliasGuard(app)
    ) {
        this.staged = new StagedBinaryPublication(app.vault.adapter);
    }

    /** What every operation which creates, changes or removes something checks before it reaches storage. */
    private async assertMayChange(path: string): Promise<void> {
        if (this.isWriteProtected(path)) throw new Error("Refusing to change a write-protected file.");
        await this.aliasGuard.assertNoAlias(path);
    }

    async writeBinaryInParts(
        path: string,
        parts: AsyncIterable<Uint8Array>,
        publication: BinaryPublication,
        options?: UXDataWriteOptions
    ): Promise<boolean> {
        assertVaultRelativePath(path);
        await this.assertMayChange(path);
        if (path === ".trash" || path.startsWith(".trash/")) throw new Error("A staging path cannot be a sync target");
        return this.staged.write(path, parts, publication, options);
    }

    async exists(path: string): Promise<boolean> {
        assertVaultRelativePath(path, true);
        return await this.app.vault.adapter.exists(path);
    }

    async trystat(path: string): Promise<Stat | null> {
        assertVaultRelativePath(path, true);
        if (!(await this.app.vault.adapter.exists(path))) return null;
        return await this.app.vault.adapter.stat(path);
    }

    async stat(path: string): Promise<Stat | null> {
        assertVaultRelativePath(path, true);
        return await this.app.vault.adapter.stat(path);
    }

    async mkdir(path: string): Promise<void> {
        assertVaultRelativePath(path, true);
        await this.assertMayChange(path);
        await this.app.vault.adapter.mkdir(path);
    }

    async remove(path: string): Promise<void> {
        assertVaultRelativePath(path);
        await this.assertMayChange(path);
        await this.app.vault.adapter.remove(path);
    }

    async read(path: string): Promise<string> {
        assertVaultRelativePath(path);
        return await this.app.vault.adapter.read(path);
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        assertVaultRelativePath(path);
        return await this.app.vault.adapter.readBinary(path);
    }

    async write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        assertVaultRelativePath(path);
        await this.assertMayChange(path);
        return await this.app.vault.adapter.write(path, data, toIntegerTimestamps(options));
    }

    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        assertVaultRelativePath(path);
        await this.assertMayChange(path);
        return await this.app.vault.adapter.writeBinary(path, toArrayBuffer(data), toIntegerTimestamps(options));
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        assertVaultRelativePath(path);
        await this.assertMayChange(path);
        return await this.app.vault.adapter.append(path, data, toIntegerTimestamps(options));
    }

    list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        assertVaultRelativePath(basePath, true);
        return Promise.resolve(this.app.vault.adapter.list(basePath));
    }
}
