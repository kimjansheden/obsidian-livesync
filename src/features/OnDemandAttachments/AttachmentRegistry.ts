import {
    parseAttachmentCacheRecord,
    validAttachmentPath,
    type AttachmentCacheRecord,
    type AttachmentCacheStore,
} from "./AttachmentCache";

export interface AttachmentRegistryStorage {
    keys(): Promise<string[]>;
    get(key: string): Promise<unknown>;
    set(key: string, record: AttachmentCacheRecord): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface AttachmentRecoveryIO {
    readRegistryFingerprint(): Promise<string | null>;
    writeRegistryFingerprint(value: string): Promise<void>;
    saveRecoveryRecord(record: AttachmentCacheRecord): Promise<void>;
    archiveRecoveryRecord(record: AttachmentCacheRecord): Promise<void>;
}

const emptyFingerprint = "0".repeat(64);
const separator = "\u0000";

function xor(a: string, b: string): string {
    return a
        .split("")
        .map((value, index) => (parseInt(value, 16) ^ parseInt(b[index], 16)).toString(16))
        .join("");
}

/** A small native checkpoint detects lost database entries without opening every cached original. */
export class AttachmentRegistry implements AttachmentCacheStore {
    private readonly entries = new Map<string, string>();
    private fingerprint = emptyFingerprint;
    private tail: Promise<unknown> = Promise.resolve();
    private valid = false;

    constructor(
        private readonly storage: AttachmentRegistryStorage,
        private readonly io: AttachmentRecoveryIO
    ) {}

    async load(): Promise<void> {
        this.valid = false;
        this.entries.clear();
        this.fingerprint = emptyFingerprint;
        const identities = new Set<string>();
        for (const encoded of await this.storage.keys()) {
            const [path, key, extra] = encoded.split(separator);
            if (
                extra !== undefined ||
                !validAttachmentPath(path) ||
                !/^[a-f0-9]{64}$/u.test(key ?? "") ||
                this.entries.has(path) ||
                identities.has(key)
            ) {
                throw new Error("Invalid attachment registry key");
            }
            this.entries.set(path, key);
            identities.add(key);
            this.fingerprint = xor(this.fingerprint, key);
        }
        const checkpoint = await this.io.readRegistryFingerprint();
        if ((checkpoint ?? emptyFingerprint) !== this.fingerprint) {
            throw new Error("The attachment registry needs recovery from its preserved originals");
        }
        this.valid = true;
    }

    private mutate<T>(task: () => Promise<T>): Promise<T> {
        const next = this.tail.then(async () => {
            if (!this.valid) throw new Error("The attachment registry is unavailable");
            try {
                return await task();
            } catch (error) {
                this.valid = false;
                throw error;
            }
        });
        this.tail = next.catch(() => {});
        return next;
    }

    keys(): Promise<string[]> {
        return Promise.resolve([...this.entries.keys()]);
    }

    async get(path: string): Promise<unknown> {
        const key = this.entries.get(path);
        return key ? await this.storage.get(`${path}${separator}${key}`) : undefined;
    }

    set(path: string, value: AttachmentCacheRecord): Promise<void> {
        return this.mutate(async () => {
            const record = parseAttachmentCacheRecord(value, path);
            const previous = this.entries.get(path);
            if (previous && previous !== record.key) throw new Error("An attachment original is already registered");
            // The native recovery description is verified before the database or original is moved.
            await this.io.saveRecoveryRecord(record);
            await this.storage.set(`${path}${separator}${record.key}`, record);
            if (!previous) {
                this.entries.set(path, record.key);
                this.fingerprint = xor(this.fingerprint, record.key);
                await this.io.writeRegistryFingerprint(this.fingerprint);
            }
        });
    }

    delete(path: string): Promise<void> {
        return this.mutate(async () => {
            const key = this.entries.get(path);
            if (!key) return;
            await this.storage.delete(`${path}${separator}${key}`);
            this.entries.delete(path);
            this.fingerprint = xor(this.fingerprint, key);
            await this.io.writeRegistryFingerprint(this.fingerprint);
        });
    }

    async archive(record: AttachmentCacheRecord): Promise<void> {
        await this.io.archiveRecoveryRecord(record);
    }
}
