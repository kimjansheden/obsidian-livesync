export const ATTACHMENT_CACHE_RECORD_VERSION = 1;
export const MAX_CACHED_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const ATTACHMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AttachmentStat {
    size: number;
    mtime: number;
    ctime: number;
}

export interface AttachmentCacheRecord {
    version: 1;
    path: string;
    key: string;
    hash: string;
    stat: AttachmentStat;
    revision?: string;
    phase: "planned" | "cached" | "restoring";
}

export interface AttachmentCacheStore {
    keys(): Promise<string[]>;
    get(key: string): Promise<unknown>;
    set(key: string, value: AttachmentCacheRecord): Promise<void>;
    delete(key: string): Promise<void>;
    archive(record: AttachmentCacheRecord): Promise<void>;
}

export interface AttachmentCacheIO {
    sourceStat(path: string): Promise<AttachmentStat | null>;
    sourceRead(path: string): Promise<ArrayBuffer>;
    cacheStat(key: string): Promise<AttachmentStat | null>;
    cacheRead(key: string): Promise<ArrayBuffer>;
    moveToCache(path: string, key: string): Promise<void>;
    moveToVault(key: string, path: string, stat: AttachmentStat): Promise<void>;
    writeCache(key: string, data: ArrayBuffer): Promise<void>;
}

export interface AttachmentCacheDependencies {
    store: AttachmentCacheStore;
    io: AttachmentCacheIO;
    hash(data: ArrayBuffer): Promise<string>;
    newKey(): string;
    withPathLock<T>(path: string, task: () => Promise<T>): Promise<T>;
    revision(path: string, hash: string, stat: AttachmentStat): Promise<string | undefined>;
    recover(record: AttachmentCacheRecord): Promise<ArrayBuffer | false>;
    afterRestore(path: string): Promise<void>;
    mayRun(): boolean;
    now(): number;
    selectionChanged?(path: string, deferred: boolean): void;
}

const attachmentExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "svg",
    "gif",
    "webp",
    "avif",
    "bmp",
    "ico",
    "tif",
    "tiff",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "mp3",
    "mp4",
    "m4a",
    "wav",
    "ogg",
    "flac",
    "mov",
    "avi",
    "webm",
    "zip",
    "7z",
    "rar",
]);

export function validAttachmentPath(path: string): boolean {
    if (!path || /[\\:\0\r\n]/u.test(path) || path.startsWith("/")) return false;
    const segments = path.split("/");
    if (segments.some((part) => !part || part.startsWith("."))) return false;
    const filename = segments[segments.length - 1];
    if (filename.lastIndexOf(".") < 1) return false;
    const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    return extension !== undefined && attachmentExtensions.has(extension);
}

export function canCacheAttachment(path: string, stat: AttachmentStat, now: number): boolean {
    return (
        validAttachmentPath(path) &&
        Number.isSafeInteger(stat.size) &&
        stat.size > 0 &&
        stat.size <= MAX_CACHED_ATTACHMENT_BYTES &&
        Number.isFinite(stat.mtime) &&
        stat.mtime > 0 &&
        stat.mtime <= now - ATTACHMENT_AGE_MS
    );
}

function sameStat(a: AttachmentStat | null, b: AttachmentStat): boolean {
    return a !== null && a.size === b.size && a.mtime === b.mtime;
}

export function parseAttachmentCacheRecord(value: unknown, path: string): AttachmentCacheRecord {
    if (!value || typeof value !== "object") throw new Error("Invalid attachment cache record");
    const record = value as Partial<AttachmentCacheRecord>;
    if (
        record.version !== 1 ||
        record.path !== path ||
        !validAttachmentPath(path) ||
        typeof record.key !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.key) ||
        typeof record.hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.hash) ||
        !record.stat ||
        !Number.isSafeInteger(record.stat.size) ||
        record.stat.size < 1 ||
        record.stat.size > MAX_CACHED_ATTACHMENT_BYTES ||
        !Number.isFinite(record.stat.mtime) ||
        !Number.isFinite(record.stat.ctime) ||
        (record.revision !== undefined && typeof record.revision !== "string") ||
        !["planned", "cached", "restoring"].includes(record.phase ?? "")
    ) {
        throw new Error("Invalid attachment cache record");
    }
    return record as AttachmentCacheRecord;
}

/** The cache owns complete original bytes; absence from the Vault is never a synced deletion. */
export class AttachmentCache {
    private readonly deferred = new Set<string>();
    private readonly pending = new Map<string, Promise<boolean>>();
    private loaded = false;

    constructor(private readonly deps: AttachmentCacheDependencies) {}

    async load(): Promise<void> {
        // Keys suffice for selection. Reading every original or record would make startup proportional to archive size.
        const paths = await this.deps.store.keys();
        for (const path of paths) {
            if (!validAttachmentPath(path)) throw new Error("Invalid attachment cache path");
            this.deferred.add(path);
            this.deps.selectionChanged?.(path, true);
        }
        this.loaded = true;
    }

    isDeferred(path: string): boolean {
        return this.deferred.has(path);
    }

    get paths(): readonly string[] {
        return [...this.deferred];
    }

    private checkRunning(): void {
        if (!this.loaded || !this.deps.mayRun()) throw new Error("Attachment cache is unavailable");
    }

    private async verify(data: ArrayBuffer, record: AttachmentCacheRecord): Promise<void> {
        if (data.byteLength !== record.stat.size || (await this.deps.hash(data)) !== record.hash) {
            throw new Error("Attachment cache content does not match its original");
        }
    }

    async dehydrate(path: string): Promise<boolean> {
        return await this.deps.withPathLock(path, async () => {
            this.checkRunning();
            if (this.deferred.has(path)) return false;
            const stat = await this.deps.io.sourceStat(path);
            if (!stat || !canCacheAttachment(path, stat, this.deps.now())) return false;
            const data = await this.deps.io.sourceRead(path);
            if (data.byteLength !== stat.size) return false;
            const hash = await this.deps.hash(data);
            const revision = await this.deps.revision(path, hash, stat);
            this.checkRunning();
            if (!revision) return false;
            if (!sameStat(await this.deps.io.sourceStat(path), stat)) return false;
            const key = this.deps.newKey();
            if (!/^[a-f0-9]{64}$/u.test(key) || (await this.deps.io.cacheStat(key))) {
                throw new Error("Attachment cache target already exists");
            }
            const record: AttachmentCacheRecord = {
                version: 1,
                path,
                key,
                hash,
                stat: { ...stat },
                revision,
                phase: "planned",
            };
            await this.deps.store.set(path, record);
            this.deferred.add(path);
            this.deps.selectionChanged?.(path, true);
            this.checkRunning();
            // A native rename preserves the only original even if execution stops before the second durable write.
            await this.deps.io.moveToCache(path, key);
            await this.verify(await this.deps.io.cacheRead(key), record);
            this.checkRunning();
            await this.deps.store.set(path, { ...record, phase: "cached" });
            return true;
        });
    }

    hydrate(path: string): Promise<boolean> {
        const pending = this.pending.get(path);
        if (pending) return pending;
        const task = this.deps.withPathLock(path, () => this.restore(path));
        this.pending.set(path, task);
        void task.finally(() => this.pending.delete(path)).catch(() => {});
        return task;
    }

    private async restore(path: string): Promise<boolean> {
        this.checkRunning();
        if (!this.deferred.has(path)) return (await this.deps.io.sourceStat(path)) !== null;
        const record = parseAttachmentCacheRecord(await this.deps.store.get(path), path);
        const current = await this.deps.io.sourceStat(path);
        if (current) {
            // Another writer or an interrupted restoration may already have materialised this path. Keep its bytes.
            this.checkRunning();
            await this.deps.store.archive(record);
            this.checkRunning();
            await this.deps.store.delete(path);
            this.deferred.delete(path);
            this.deps.selectionChanged?.(path, false);
            await this.deps.afterRestore(path);
            return true;
        }
        if (!(await this.deps.io.cacheStat(record.key))) {
            const recovered = await this.deps.recover(record);
            if (recovered === false) throw new Error("The original attachment is unavailable");
            await this.verify(recovered, record);
            this.checkRunning();
            await this.deps.io.writeCache(record.key, recovered);
        }
        await this.verify(await this.deps.io.cacheRead(record.key), record);
        this.checkRunning();
        await this.deps.store.set(path, { ...record, phase: "restoring" });
        if (await this.deps.io.sourceStat(path)) throw new Error("Attachment target changed before restoration");
        this.checkRunning();
        await this.deps.io.moveToVault(record.key, path, record.stat);
        await this.verify(await this.deps.io.sourceRead(path), record);
        this.checkRunning();
        await this.deps.store.archive(record);
        this.checkRunning();
        await this.deps.store.delete(path);
        this.deferred.delete(path);
        this.deps.selectionChanged?.(path, false);
        await this.deps.afterRestore(path);
        return true;
    }
}
