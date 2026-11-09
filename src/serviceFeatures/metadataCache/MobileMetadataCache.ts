import type { App } from "obsidian";

interface CacheTransaction {
    store: { delete: (path: string) => Promise<unknown> };
    done: Promise<unknown>;
}

interface CacheHost {
    fileCache: Record<string, unknown>;
    preload: () => Promise<void>;
    initialize: () => Promise<void>;
    db?: { transaction: (store: "file", mode: "readwrite") => CacheTransaction };
}

const installed = Symbol.for("obsidian-livesync:mobile-metadata-cache-pruning");
const batchSize = 512;
export const MOBILE_METADATA_CACHE_FAILURE =
    "The local file cache could not be refreshed. Restart Obsidian before preparing attachments.";

/** Removes derived file-index entries without changing files, parsed note metadata, or sync state. */
export class MobileMetadataCache {
    private readonly cache: unknown;
    private readonly vault: App["vault"];

    constructor(app: App) {
        this.cache = app.metadataCache;
        this.vault = app.vault;
    }

    private host(): CacheHost {
        const value = this.cache as Partial<CacheHost> | undefined;
        if (
            !value ||
            !value.fileCache ||
            typeof value.fileCache !== "object" ||
            Array.isArray(value.fileCache) ||
            typeof value.preload !== "function" ||
            typeof value.initialize !== "function"
        )
            throw new Error("The Android metadata cache is unavailable");
        return value as CacheHost;
    }

    async forget(paths: readonly string[]): Promise<void> {
        if (paths.length === 0) return;
        const host = this.host();
        if (typeof host.db?.transaction !== "function")
            throw new Error("The Android metadata cache database is unavailable");
        const transaction = host.db.transaction("file", "readwrite");
        if (typeof transaction.store?.delete !== "function" || typeof transaction.done?.then !== "function")
            throw new Error("The Android metadata cache transaction is unavailable");
        await Promise.all([...paths.map((path) => transaction.store.delete(path)), transaction.done]);
        for (const path of paths)
            if (!Reflect.deleteProperty(host.fileCache, path))
                throw new Error("The Android metadata cache entry could not be retired");
    }

    async pruneMissing(mayRun: () => boolean = () => true): Promise<number> {
        const host = this.host();
        await host.preload();
        const missing = Object.keys(host.fileCache).filter((path) => !this.vault.getFileByPath(path));
        let pruned = 0;
        for (let offset = 0; offset < missing.length && mayRun(); offset += batchSize) {
            const batch = missing.slice(offset, offset + batchSize);
            await this.forget(batch);
            pruned += batch.length;
        }
        return pruned;
    }

    install(registerCleanup: (cleanup: () => void) => void, onFailure: () => void): void {
        let host: CacheHost;
        try {
            host = this.host();
        } catch {
            return;
        }
        const original = host.initialize;
        if (Reflect.get(original, installed) === true) return;
        let active = true;
        const initialise = async () => {
            if (active) {
                try {
                    // Obsidian calls this after Vault.load; its resident file map is complete.
                    await this.pruneMissing(() => active);
                } catch {
                    onFailure();
                }
            }
            await original.call(host);
        };
        Reflect.set(initialise, installed, true);
        host.initialize = initialise;
        registerCleanup(() => {
            active = false;
            if (host.initialize === initialise) host.initialize = original;
        });
    }
}
