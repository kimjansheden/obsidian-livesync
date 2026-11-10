import type { App } from "obsidian";

interface CacheTransaction {
    store: { delete: (path: string) => Promise<unknown> };
    done: Promise<unknown>;
}

interface CacheHost {
    initialized?: boolean;
    fileCache: Record<string, unknown>;
    preload: () => Promise<void>;
    initialize: () => Promise<void>;
    transactionSave?: (store: string, key: string, value: unknown) => unknown;
    db?: { transaction: (store: "file", mode: "readwrite") => CacheTransaction };
}

const installed = Symbol.for("obsidian-livesync:mobile-metadata-cache-pruning");
const writeFilter = Symbol.for("obsidian-livesync:mobile-file-cache-write-filter");
const batchSize = 512;
export const MOBILE_METADATA_CACHE_FAILURE =
    "The local file cache could not be refreshed. Restart Obsidian before preparing attachments.";

function emptyHashEntry(value: unknown): value is { hash: ""; mtime: number; size: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== 3 || keys.some((key) => key !== "hash" && key !== "mtime" && key !== "size")) return false;
    const entry = value as { hash?: unknown; mtime?: unknown; size?: unknown };
    return (
        entry.hash === "" &&
        typeof entry.mtime === "number" &&
        Number.isFinite(entry.mtime) &&
        typeof entry.size === "number" &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0
    );
}

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

    private filterUnchangedFileWrites(host: CacheHost): () => void {
        const original = host.transactionSave;
        if (host.initialized !== false || typeof original !== "function" || Reflect.get(original, writeFilter) === true)
            return () => {};
        const persisted = new Map<string, { mtime: number; size: number }>();
        for (const [path, entry] of Object.entries(host.fileCache)) {
            const file = this.vault.getFileByPath(path);
            if (
                file &&
                typeof file.extension === "string" &&
                file.extension.toLowerCase() !== "md" &&
                emptyHashEntry(entry)
            ) {
                persisted.set(path, { mtime: entry.mtime, size: entry.size });
            }
        }
        if (persisted.size === 0) return () => {};
        let active = true;
        const filtered = function (this: CacheHost, store: string, key: string, value: unknown): unknown {
            if (active && store === "file") {
                const previous = persisted.get(key);
                if (
                    previous &&
                    emptyHashEntry(value) &&
                    value.mtime === previous.mtime &&
                    value.size === previous.size
                ) {
                    return Promise.resolve(key);
                }
                // A changed or deleted row invalidates the preloaded value for every subsequent write.
                persisted.delete(key);
            }
            return original.call(this, store, key, value);
        };
        Reflect.set(filtered, writeFilter, true);
        if (!Reflect.set(host, "transactionSave", filtered)) return () => {};
        return () => {
            active = false;
            persisted.clear();
            if (host.transactionSave === filtered) Reflect.set(host, "transactionSave", original);
        };
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
        const filters = new Set<() => void>();
        const initialise = async () => {
            let cacheReady = false;
            if (active) {
                try {
                    // Obsidian calls this after Vault.load; its resident file map is complete.
                    await this.pruneMissing(() => active);
                    cacheReady = active;
                } catch {
                    onFailure();
                }
            }
            const restore = active && cacheReady ? this.filterUnchangedFileWrites(host) : () => {};
            filters.add(restore);
            try {
                await original.call(host);
            } finally {
                restore();
                filters.delete(restore);
            }
        };
        Reflect.set(initialise, installed, true);
        host.initialize = initialise;
        registerCleanup(() => {
            active = false;
            for (const restore of filters) restore();
            filters.clear();
            if (host.initialize === initialise) host.initialize = original;
        });
    }
}
