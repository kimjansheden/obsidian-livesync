import type { UXDataWriteOptions } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { IStorageAdapter } from "@vrtmrz/livesync-commonlib/compat/serviceModules/adapters";
import { toArrayBuffer } from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import type { Stat, App } from "obsidian";
import { toIntegerTimestamps } from "./sanitizeWriteOptions";

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
    constructor(private app: App) {}

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
        await this.app.vault.adapter.mkdir(path);
    }

    async remove(path: string): Promise<void> {
        assertVaultRelativePath(path);
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
        return await this.app.vault.adapter.write(path, data, toIntegerTimestamps(options));
    }

    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        assertVaultRelativePath(path);
        return await this.app.vault.adapter.writeBinary(path, toArrayBuffer(data), toIntegerTimestamps(options));
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        assertVaultRelativePath(path);
        return await this.app.vault.adapter.append(path, data, toIntegerTimestamps(options));
    }

    list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        assertVaultRelativePath(basePath, true);
        return Promise.resolve(this.app.vault.adapter.list(basePath));
    }
}
