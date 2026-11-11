import type { App, DataAdapter, Stat } from "obsidian";
import type { AttachmentCacheIO, AttachmentStat } from "./AttachmentCache";
import { parseAttachmentCacheRecord, validAttachmentPath, type AttachmentCacheRecord } from "./AttachmentCache";
import type { AttachmentRecoveryIO } from "./AttachmentRegistry";
import { MobileMetadataCache } from "@/serviceFeatures/metadataCache/MobileMetadataCache";

interface NativeStat {
    type: "file" | "directory";
    size: number;
    mtime: number;
    ctime: number;
}

interface MobileNativeFileSystem {
    stat(path: string): Promise<NativeStat>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    setTimes(path: string, ctime: number, mtime: number): Promise<void>;
    readdir(path: string): Promise<{ name: string; type: "file" | "directory" }[]>;
}

interface MobileVaultAdapter extends DataAdapter {
    onFileChange?: (path: unknown) => void;
    fs: MobileNativeFileSystem;
    getFullPath(path: string): string;
    queue<T>(task: () => Promise<T>): Promise<T>;
    reconcileFile(path: string, normalised: string, trigger?: boolean): Promise<void>;
}

function isMobileVaultAdapter(adapter: DataAdapter): adapter is MobileVaultAdapter {
    const value = adapter as Partial<MobileVaultAdapter>;
    return (
        typeof value.getFullPath === "function" &&
        typeof value.queue === "function" &&
        typeof value.reconcileFile === "function" &&
        value.fs !== undefined &&
        ["stat", "mkdir", "rename", "readBinary", "writeBinary", "setTimes"].every(
            (name) => typeof value.fs?.[name as keyof MobileNativeFileSystem] === "function"
        )
    );
}

function missing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function sha256Buffer(data: ArrayBuffer): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
}

function attachmentStat(stat: Stat | NativeStat | null): AttachmentStat | null {
    if (!stat) return null;
    if (
        stat.type !== "file" ||
        !Number.isFinite(stat.size) ||
        !Number.isFinite(stat.ctime) ||
        !Number.isFinite(stat.mtime)
    ) {
        throw new Error("Attachment path is not a regular file");
    }
    return { size: stat.size, ctime: stat.ctime, mtime: stat.mtime };
}

/** An Android-only, opaque cache beside the Vault. Every raw native path is confined before use. */
export class MobileAttachmentCacheIO implements AttachmentCacheIO, AttachmentRecoveryIO {
    private eventLease?: Promise<() => void>;
    private recoveryMetadataTail: Promise<unknown> = Promise.resolve();
    private constructor(
        private readonly adapter: MobileVaultAdapter,
        private readonly vaultRoot: string,
        private readonly cacheRoot: string,
        private readonly metadataCache: MobileMetadataCache,
        private readonly mayRun: () => boolean
    ) {}

    deferRetiredFileEvents(isDeferred: (path: string) => boolean): Promise<() => void> {
        if (this.eventLease) return this.eventLease;
        const lease = this.adapter.queue(() => {
            this.checkRunning();
            const original = this.adapter.onFileChange;
            if (typeof original !== "function") throw new Error("The Android file event handler is unavailable");
            let active = true;
            const filtered = (path: unknown) => {
                if (active && typeof path === "string" && isDeferred(path.replace(/^\/+/u, ""))) return;
                original.call(this.adapter, path);
            };
            this.adapter.onFileChange = filtered;
            return Promise.resolve(() => {
                if (!active) return;
                active = false;
                if (this.adapter.onFileChange === filtered) Reflect.set(this.adapter, "onFileChange", original);
                this.eventLease = undefined;
            });
        });
        this.eventLease = lease;
        void lease.catch(() => {
            if (this.eventLease === lease) this.eventLease = undefined;
        });
        return lease;
    }

    static async create(app: App, mayRun: () => boolean = () => true): Promise<MobileAttachmentCacheIO> {
        const adapter = app.vault.adapter;
        if (!isMobileVaultAdapter(adapter)) throw new Error("On-demand attachments require the Android file adapter");
        const base = adapter.getFullPath("").replace(/\/+$/u, "");
        if (
            !base.startsWith("/storage/") ||
            base.includes("/../") ||
            base.includes("/./") ||
            /[\\\0\r\n]/u.test(base)
        ) {
            throw new Error("Unsupported Android Vault location");
        }
        const parent = base.slice(0, base.lastIndexOf("/"));
        const identity = await sha256Buffer(new TextEncoder().encode(base).buffer);
        return new MobileAttachmentCacheIO(
            adapter,
            base,
            `${parent}/.livesync-attachment-cache/${identity}`,
            new MobileMetadataCache(app),
            mayRun
        );
    }

    private checkRunning(): void {
        if (!this.mayRun()) throw new Error("Attachment file operations stopped");
    }

    async readMetadataSnapshot(): Promise<ArrayBuffer | null> {
        this.checkRunning();
        try {
            return await this.adapter.fs.readBinary(`${this.cacheRoot}/metadata-startup-v1.cache`);
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    }

    async writeMetadataSnapshot(bytes: ArrayBuffer): Promise<void> {
        await this.queueRecoveryMetadata(async () => {
            this.checkRunning();
            await this.ensureDirectory(this.cacheRoot);
            this.checkRunning();
            // This is a disposable derivative; an interrupted write falls back to the unchanged native cache.
            await this.adapter.fs.writeBinary(`${this.cacheRoot}/metadata-startup-v1.cache`, bytes);
        });
    }

    private queueRecoveryMetadata<T>(task: () => Promise<T>): Promise<T> {
        const next = this.recoveryMetadataTail.then(() => {
            this.checkRunning();
            return task();
        });
        this.recoveryMetadataTail = next.catch(() => {});
        return next;
    }

    async waitForRecoveryMetadata(): Promise<void> {
        await this.recoveryMetadataTail;
    }

    private source(path: string): string {
        if (!validAttachmentPath(path)) throw new Error("Unsafe attachment path");
        const full = this.adapter.getFullPath(path);
        if (!full.startsWith(`${this.vaultRoot}/`) || full !== `${this.vaultRoot}/${path}`) {
            throw new Error("Attachment path leaves the Vault");
        }
        return full;
    }

    private cached(key: string): string {
        if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Unsafe attachment cache key");
        return `${this.cacheRoot}/${key.slice(0, 2)}/${key}.bin`;
    }

    private async readJson(path: string): Promise<unknown> {
        const stat = await this.nativeStat(path);
        if (!stat) return undefined;
        if (stat.size > 65536) throw new Error("Attachment recovery metadata is too large");
        return JSON.parse(new TextDecoder().decode(await this.adapter.fs.readBinary(path))) as unknown;
    }

    private async writeJson(path: string, value: unknown): Promise<void> {
        const encoded = JSON.stringify(value);
        if (encoded.length > 65536) throw new Error("Attachment recovery metadata is too large");
        await this.ensureDirectory(path.slice(0, path.lastIndexOf("/")));
        this.checkRunning();
        await this.adapter.fs.writeBinary(path, new TextEncoder().encode(encoded).buffer);
        if (JSON.stringify(await this.readJson(path)) !== encoded) throw new Error("Attachment recovery write failed");
    }

    async readRegistryFingerprint(): Promise<string | null> {
        const value = await this.readJson(`${this.cacheRoot}/registry.json`);
        if (value === undefined) return null;
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
            throw new Error("Invalid attachment recovery checkpoint");
        return value;
    }

    async writeRegistryFingerprint(value: string): Promise<void> {
        if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid attachment recovery checkpoint");
        await this.queueRecoveryMetadata(async () => {
            this.checkRunning();
            await this.writeJson(`${this.cacheRoot}/registry.json`, value);
        });
    }

    async saveRecoveryRecord(record: AttachmentCacheRecord): Promise<void> {
        parseAttachmentCacheRecord(record, record.path);
        const path = this.cached(record.key).replace(/\.bin$/u, ".json");
        await this.queueRecoveryMetadata(async () => {
            this.checkRunning();
            const existing = await this.readJson(path);
            if (existing !== undefined) {
                const original = parseAttachmentCacheRecord(existing, record.path);
                if (
                    original.key !== record.key ||
                    original.hash !== record.hash ||
                    JSON.stringify(original.stat) !== JSON.stringify(record.stat) ||
                    original.revision !== record.revision
                )
                    throw new Error("An attachment recovery record cannot replace another original");
                return;
            }
            await this.writeJson(path, record);
        });
    }

    async recoveryRecords(): Promise<AttachmentCacheRecord[]> {
        const records: AttachmentCacheRecord[] = [];
        // This full directory walk belongs only to explicit recovery, never ordinary startup.
        for (let index = 0; index < 256; index++) {
            this.checkRunning();
            const directory = `${this.cacheRoot}/${index.toString(16).padStart(2, "0")}`;
            let names: { name: string; type: "file" | "directory" }[];
            try {
                names = await this.adapter.fs.readdir(directory);
            } catch (error) {
                if (missing(error)) continue;
                throw error;
            }
            for (const entry of names) {
                const name = entry.name;
                if (entry.type !== "file") continue;
                if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
                const value = await this.readJson(`${directory}/${name}`);
                if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string")
                    throw new Error("Invalid attachment recovery record");
                const record = parseAttachmentCacheRecord(value, value.path);
                if (`${record.key}.json` !== name || !name.startsWith(index.toString(16).padStart(2, "0")))
                    throw new Error("Attachment recovery record identity mismatch");
                const completed = await this.readJson(this.cached(record.key).replace(/\.bin$/u, ".done.json"));
                if (completed !== undefined && completed !== record.hash)
                    throw new Error("Invalid attachment recovery completion");
                if (completed === record.hash && !(await this.cacheStat(record.key))) continue;
                records.push(record);
            }
        }
        return records;
    }

    async archiveRecoveryRecord(record: AttachmentCacheRecord, restoredPath = record.path): Promise<void> {
        await this.saveRecoveryRecord(record);
        if (await this.cacheStat(record.key)) return;
        const source = await this.sourceStat(restoredPath);
        if (
            !source ||
            source.size !== record.stat.size ||
            (await sha256Buffer(await this.sourceRead(restoredPath))) !== record.hash
        )
            return;
        await this.queueRecoveryMetadata(async () => {
            this.checkRunning();
            await this.writeJson(this.cached(record.key).replace(/\.bin$/u, ".done.json"), record.hash);
        });
    }

    private async nativeStat(path: string): Promise<AttachmentStat | null> {
        try {
            return attachmentStat(await this.adapter.fs.stat(path));
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    }

    private async ensureDirectory(path: string): Promise<void> {
        try {
            const stat = await this.adapter.fs.stat(path);
            if (stat.type !== "directory") throw new Error("Attachment parent is not a directory");
            return;
        } catch (error) {
            if (!missing(error)) throw error;
        }
        try {
            await this.adapter.fs.mkdir(path);
        } catch (error) {
            // A native watcher or another queued operation may have created the same directory.
            if ((await this.adapter.fs.stat(path)).type !== "directory") throw error;
        }
    }

    async sourceStat(path: string): Promise<AttachmentStat | null> {
        return await this.nativeStat(this.source(path));
    }

    async sourceRead(path: string): Promise<ArrayBuffer> {
        this.source(path);
        return await this.adapter.readBinary(path);
    }

    async cacheStat(key: string): Promise<AttachmentStat | null> {
        return await this.nativeStat(this.cached(key));
    }

    async cacheRead(key: string): Promise<ArrayBuffer> {
        return await this.adapter.fs.readBinary(this.cached(key));
    }

    async moveToCache(path: string, key: string): Promise<void> {
        const source = this.source(path),
            target = this.cached(key);
        await this.adapter.queue(async () => {
            this.checkRunning();
            if (!(await this.nativeStat(source)) || (await this.nativeStat(target))) {
                throw new Error("Attachment cache move cannot replace another file");
            }
            await this.ensureDirectory(target.slice(0, target.lastIndexOf("/")));
            // Commit the derived-cache removal before the original can leave the Vault.
            await this.metadataCache.forget([path]);
            this.checkRunning();
            await this.adapter.fs.rename(source, target);
            // The deferred registry owns this path until restoration. Rebuild the file cache on restart.
        });
    }

    async moveToVault(key: string, path: string, stat: AttachmentStat): Promise<void> {
        const source = this.cached(key),
            target = this.source(path);
        await this.adapter.queue(async () => {
            this.checkRunning();
            if (!(await this.nativeStat(source)) || (await this.nativeStat(target))) {
                throw new Error("Attachment restoration cannot replace another file");
            }
            await this.ensureDirectory(target.slice(0, target.lastIndexOf("/")));
            this.checkRunning();
            await this.adapter.fs.rename(source, target);
            await this.adapter.fs.setTimes(target, stat.ctime, stat.mtime);
            await this.adapter.reconcileFile(path, path, true);
        });
    }

    async writeCache(key: string, data: ArrayBuffer): Promise<void> {
        const target = this.cached(key);
        await this.adapter.queue(async () => {
            this.checkRunning();
            if (await this.nativeStat(target)) throw new Error("Attachment cache target already exists");
            await this.ensureDirectory(target.slice(0, target.lastIndexOf("/")));
            this.checkRunning();
            await this.adapter.fs.writeBinary(target, data);
        });
    }
}
