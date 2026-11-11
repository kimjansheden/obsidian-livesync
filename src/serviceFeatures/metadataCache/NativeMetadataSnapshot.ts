/** Reuses immutable, content-addressed native metadata without changing its canonical IndexedDB records. */
export interface NativeMetadataStore {
    getAllKeys(range?: IDBKeyRange, count?: number): Promise<string[]>;
    getAll(range?: IDBKeyRange, count?: number): Promise<unknown[]>;
    get(key: string): Promise<unknown>;
}
export interface NativeMetadataTransaction {
    objectStore(name: string): NativeMetadataStore;
    readonly store: NativeMetadataStore;
    readonly done: Promise<unknown>;
}
export interface NativeMetadataDatabase {
    close?(): void;
    transaction(
        stores: string | string[],
        mode: "readonly" | "readwrite",
        ...options: unknown[]
    ): NativeMetadataTransaction;
}
export interface NativeMetadataHost {
    db: NativeMetadataDatabase | null;
    initialized: boolean;
    inProgressTaskCount: number;
    _preload(): Promise<void>;
}
export interface MetadataSnapshotIO {
    readMetadataSnapshot(): Promise<ArrayBuffer | null>;
    writeMetadataSnapshot(bytes: ArrayBuffer): Promise<void>;
}
interface Snapshot {
    format: 1;
    appVersion: string;
    metadata: Record<string, unknown>;
}
const maxDecodedBytes = 256 * 1024 * 1024;
const maxPackedBytes = 64 * 1024 * 1024;
const maxHeaderBytes = 1024;
const prefix = new Uint8Array([76, 83, 77, 67, 49, 0]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const installed = Symbol.for("obsidian-livesync:native-metadata-snapshot");
function validMetadataKeys(metadata: Record<string, unknown>): boolean {
    return Object.keys(metadata).every(
        (key) => key.length > 0 && key.length <= 512 && !["__proto__", "constructor", "prototype"].includes(key)
    );
}

async function digest(bytes: ArrayBuffer): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<ArrayBuffer> {
    const reader = stream.getReader(),
        chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > limit) throw new Error("Metadata snapshot exceeds its size bound");
            chunks.push(next.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

function plainMetadata(value: unknown, ancestors = new WeakSet<object>()): boolean {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    if (Array.isArray(value) && (Object.keys(value).length !== value.length || value.includes(undefined))) return false;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    ancestors.add(value);
    const valid = Object.values(value).every((child: unknown) => plainMetadata(child, ancestors));
    ancestors.delete(value);
    return valid;
}

export async function encodeNativeMetadataSnapshot(snapshot: Snapshot): Promise<ArrayBuffer> {
    if (!plainMetadata(snapshot.metadata) || !validMetadataKeys(snapshot.metadata))
        throw new Error("Native metadata requires its original loader");
    const bytes = encoder.encode(JSON.stringify(snapshot));
    if (bytes.byteLength > maxDecodedBytes) throw new Error("Metadata snapshot exceeds its size bound");
    const header = encoder.encode(
        JSON.stringify({ format: 1, bytes: bytes.byteLength, sha256: await digest(bytes.buffer) })
    );
    const packed = await readBounded(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
        maxPackedBytes
    );
    const result = new Uint8Array(prefix.length + 4 + header.byteLength + packed.byteLength);
    result.set(prefix);
    new DataView(result.buffer).setUint32(prefix.length, header.byteLength, true);
    result.set(header, prefix.length + 4);
    result.set(new Uint8Array(packed), prefix.length + 4 + header.byteLength);
    return result.buffer;
}

export async function decodeNativeMetadataSnapshot(bytes: ArrayBuffer, appVersion: string): Promise<Snapshot> {
    const data = new Uint8Array(bytes);
    if (
        data.byteLength < prefix.length + 4 ||
        data.byteLength > maxPackedBytes + maxHeaderBytes + prefix.length + 4 ||
        !prefix.every((byte, index) => data[index] === byte)
    )
        throw new Error("Invalid metadata snapshot header");
    const headerLength = new DataView(bytes).getUint32(prefix.length, true),
        start = prefix.length + 4;
    if (headerLength === 0 || headerLength > maxHeaderBytes || start + headerLength >= data.byteLength)
        throw new Error("Invalid metadata snapshot header");
    const header = JSON.parse(decoder.decode(data.subarray(start, start + headerLength))) as {
        format?: unknown;
        bytes?: unknown;
        sha256?: unknown;
    };
    if (
        header.format !== 1 ||
        !Number.isSafeInteger(header.bytes) ||
        (header.bytes as number) < 1 ||
        (header.bytes as number) > maxDecodedBytes ||
        typeof header.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(header.sha256)
    )
        throw new Error("Invalid metadata snapshot bounds");
    const unpacked = await readBounded(
        new Blob([data.subarray(start + headerLength)]).stream().pipeThrough(new DecompressionStream("gzip")),
        header.bytes as number
    );
    if (unpacked.byteLength !== header.bytes || (await digest(unpacked)) !== header.sha256)
        throw new Error("Metadata snapshot content differs");
    const snapshot = JSON.parse(decoder.decode(unpacked)) as Partial<Snapshot>;
    if (
        snapshot.format !== 1 ||
        snapshot.appVersion !== appVersion ||
        !snapshot.metadata ||
        typeof snapshot.metadata !== "object" ||
        Array.isArray(snapshot.metadata) ||
        !validMetadataKeys(snapshot.metadata)
    )
        throw new Error("Unsupported metadata snapshot");
    return snapshot as Snapshot;
}

function forward(target: object, property: PropertyKey): unknown {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
}

/** Every canonical key is still enumerated; a missing snapshot entry is read from its native store. */
export async function preloadWithMetadataSnapshot(
    host: NativeMetadataHost,
    snapshot: Snapshot,
    preload: () => Promise<void>
): Promise<number> {
    const descriptor = Object.getOwnPropertyDescriptor(host, "db");
    if (!descriptor?.configurable || descriptor.get || descriptor.set) {
        await preload();
        return 0;
    }
    let readFailed = false;
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            return await operation();
        } catch (error) {
            readFailed = true;
            throw error;
        }
    };
    let database = host.db,
        restoreTransaction: (() => void) | undefined,
        fetched = 0;
    const assign = (value: NativeMetadataDatabase | null) => {
        database = value;
        if (!value) return;
        const original = value.transaction.bind(value),
            own = Object.getOwnPropertyDescriptor(value, "transaction");
        const transaction = (stores: string | string[], mode: "readonly" | "readwrite", ...options: unknown[]) => {
            const tx = original.call(value, stores, mode, ...options);
            if (
                mode !== "readonly" ||
                !Array.isArray(stores) ||
                !stores.includes("metadata") ||
                typeof tx.done?.then !== "function"
            )
                return tx;
            return new Proxy(tx, {
                get(target, property) {
                    if (property !== "objectStore") return forward(target, property);
                    return (name: string) => {
                        const store = target.objectStore(name);
                        if (name !== "metadata") return store;
                        let keys: string[] = [];
                        let keysRead = false;
                        return new Proxy(store, {
                            get(source, method) {
                                if (method === "getAllKeys")
                                    return async (range?: IDBKeyRange, count?: number) => {
                                        keys = await read(() => source.getAllKeys(range, count));
                                        keysRead = range === undefined && count === undefined;
                                        if (keys.some((key) => typeof key !== "string"))
                                            throw new Error("Unsupported native metadata key");
                                        fetched += keys.filter(
                                            (key) => !Object.prototype.hasOwnProperty.call(snapshot.metadata, key)
                                        ).length;
                                        return keys;
                                    };
                                if (method === "getAll")
                                    return async (range?: IDBKeyRange, count?: number) => {
                                        if (!keysRead) return await read(() => source.getAll(range, count));
                                        const matching = keys.filter((key) => !range || range.includes(key));
                                        const selected = count === undefined ? matching : matching.slice(0, count);
                                        const missing = selected.some(
                                            (key) => !Object.prototype.hasOwnProperty.call(snapshot.metadata, key)
                                        );
                                        const fresh = missing
                                            ? original.call(value, "metadata", "readonly")
                                            : undefined;
                                        return await read(async () => {
                                            const [values] = await Promise.all([
                                                Promise.all(
                                                    selected.map((key) =>
                                                        Object.prototype.hasOwnProperty.call(snapshot.metadata, key)
                                                            ? snapshot.metadata[key]
                                                            : fresh!.store.get(key)
                                                    )
                                                ),
                                                fresh?.done,
                                            ]);
                                            return values;
                                        });
                                    };
                                return forward(source, method);
                            },
                        });
                    };
                },
            });
        };
        value.transaction = transaction;
        restoreTransaction = () => {
            if (Object.getOwnPropertyDescriptor(value, "transaction")?.value === transaction) {
                if (own) Object.defineProperty(value, "transaction", own);
                else Reflect.deleteProperty(value, "transaction");
            }
        };
    };
    Object.defineProperty(host, "db", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => database,
        set: assign,
    });
    try {
        await preload();
        if (readFailed) throw new Error("Native metadata snapshot read failed");
        return fetched;
    } finally {
        restoreTransaction?.();
        Object.defineProperty(host, "db", { ...descriptor, value: database });
    }
}

export class NativeMetadataSnapshot {
    private active = true;
    private preparing?: Promise<boolean>;
    private needsPreparation = true;
    private maintenanceAttempted = false;
    private maintenanceTimer?: number;
    constructor(
        private readonly host: NativeMetadataHost,
        private readonly io: MetadataSnapshotIO,
        private readonly appVersion: string,
        private readonly mayMaintain: () => boolean = () => false
    ) {}

    install(registerCleanup: (cleanup: () => void) => void): void {
        const previous = Reflect.get(this.host, "_preload");
        if (Reflect.get(previous, installed) === true) return;
        const descriptor = Object.getOwnPropertyDescriptor(this.host, "_preload");
        const original = previous.bind(this.host);
        const preload = async () => {
            let snapshot: Snapshot | undefined;
            try {
                const bytes = await this.io.readMetadataSnapshot();
                if (bytes && this.active) snapshot = await decodeNativeMetadataSnapshot(bytes, this.appVersion);
            } catch {
                /* The canonical native cache remains authoritative. */
            }
            if (!snapshot || !this.active) {
                await original.call(this.host);
                this.requestPreparation();
                return;
            }
            try {
                const missing = await preloadWithMetadataSnapshot(this.host, snapshot, () => original.call(this.host));
                this.needsPreparation = missing >= 128;
            } catch {
                this.host.db?.close?.();
                await original.call(this.host);
                this.needsPreparation = true;
            }
            this.requestPreparation();
        };
        Reflect.set(preload, installed, true);
        this.host._preload = preload;
        registerCleanup(() => {
            this.active = false;
            if (this.maintenanceTimer) window.clearTimeout(this.maintenanceTimer);
            if (this.host._preload === preload) {
                if (descriptor) Object.defineProperty(this.host, "_preload", descriptor);
                else Reflect.deleteProperty(this.host, "_preload");
            }
        });
    }

    requestPreparation(): void {
        if (!this.active || !this.needsPreparation || this.maintenanceAttempted || this.maintenanceTimer) return;
        this.maintenanceTimer = window.setTimeout(() => {
            this.maintenanceTimer = undefined;
            if (!this.active || !this.needsPreparation || !this.mayMaintain()) return;
            this.maintenanceAttempted = true;
            void this.prepare().catch(() => false);
        }, 30_000);
    }

    async waitForPreparation(): Promise<void> {
        await this.preparing?.then(
            () => undefined,
            () => undefined
        );
    }
    get hasPendingPreparation(): boolean {
        return this.preparing !== undefined;
    }

    prepare(): Promise<boolean> {
        return (this.preparing ??= this.capture().finally(() => {
            this.preparing = undefined;
        }));
    }
    private async capture(): Promise<boolean> {
        const database = this.host.db;
        if (!this.active || !database || !this.host.initialized || this.host.inProgressTaskCount !== 0) return false;
        const tx = database.transaction("metadata", "readonly"),
            keys = await tx.store.getAllKeys(),
            values = await tx.store.getAll();
        await tx.done;
        if (!this.active || database !== this.host.db || this.host.inProgressTaskCount !== 0) return false;
        const metadata = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
        const bytes = await encodeNativeMetadataSnapshot({ format: 1, appVersion: this.appVersion, metadata });
        if (!this.active || database !== this.host.db) return false;
        await this.io.writeMetadataSnapshot(bytes);
        return this.active;
    }
}
