import "fake-indexeddb/auto";
import { openDB, deleteDB, type DBSchema } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    NativeMetadataSnapshot,
    decodeNativeMetadataSnapshot,
    encodeNativeMetadataSnapshot,
    type NativeMetadataDatabase,
    type NativeMetadataHost,
} from "./NativeMetadataSnapshot";

interface CacheSchema extends DBSchema {
    file: { key: string; value: unknown };
    metadata: { key: string; value: unknown };
}
const version = "1.15.0";
const rows = {
    a: { v: 1, links: [{ link: "Synthetic target", position: [1, 2, 3, 4] }] },
    c: { v: 1, frontmatter: { category: "synthetic", enabled: true } },
};
const snapshot = (metadata: Record<string, unknown> = rows) => ({ format: 1 as const, appVersion: version, metadata });
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
});

async function fixture(nativeRows: Record<string, unknown> = rows) {
    const name = `native-metadata-${crypto.randomUUID()}`;
    const created = await openDB<CacheSchema>(name, 1, {
        upgrade(db) {
            db.createObjectStore("file");
            db.createObjectStore("metadata");
        },
    });
    for (const [key, value] of Object.entries(nativeRows)) await created.put("metadata", value, key);
    created.close();
    let connection: Awaited<ReturnType<typeof openDB<CacheSchema>>> | undefined;
    const host: NativeMetadataHost & { rows: Record<string, unknown>; withoutKeys: boolean } = {
        db: null,
        initialized: true,
        inProgressTaskCount: 0,
        rows: {},
        withoutKeys: false,
        async _preload() {
            const db = (connection = await openDB<CacheSchema>(name));
            this.db = db as unknown as NativeMetadataDatabase;
            const tx = db.transaction(["file", "metadata"], "readonly"),
                store = tx.objectStore("metadata");
            if (this.withoutKeys) {
                this.rows = { all: await store.getAll() };
                return;
            }
            const keys = await store.getAllKeys();
            let from = 0;
            while (from < keys.length) {
                const values = await store.getAll(IDBKeyRange.lowerBound(keys[from]), 2);
                if (!values.length) break;
                values.forEach((value, index) => {
                    this.rows[keys[from + index]] = value;
                });
                from += values.length;
            }
            await tx.done;
        },
    };
    let bytes: ArrayBuffer | null = await encodeNativeMetadataSnapshot(snapshot());
    const io = {
        readMetadataSnapshot: vi.fn(async () => bytes),
        writeMetadataSnapshot: vi.fn(async (value: ArrayBuffer) => {
            bytes = value;
        }),
    };
    const restores: (() => void)[] = [];
    const create = (mayMaintain = () => false) => {
        const component = new NativeMetadataSnapshot(host, io, version, mayMaintain);
        component.install((cleanup) => restores.push(cleanup));
        return component;
    };
    cleanups.push(async () => {
        restores.forEach((restore) => restore());
        connection?.close();
        await deleteDB(name);
    });
    return {
        host,
        io,
        create,
        stop: () => restores.forEach((restore) => restore()),
        setBytes: (value: ArrayBuffer | null) => {
            bytes = value;
        },
        canonical: async () => await connection!.getAll("metadata"),
    };
}

describe("bounded native metadata snapshots", () => {
    it("round-trips native compact metadata and optional fields", async () => {
        const input = snapshot();
        expect(await decodeNativeMetadataSnapshot(await encodeNativeMetadataSnapshot(input), version)).toEqual(input);
    });
    it("rejects corrupt payloads and an incompatible native version", async () => {
        const packed = await encodeNativeMetadataSnapshot(snapshot());
        const changed = packed.slice(0);
        new Uint8Array(changed)[changed.byteLength - 1] ^= 1;
        await expect(decodeNativeMetadataSnapshot(changed, version)).rejects.toThrow();
        await expect(decodeNativeMetadataSnapshot(packed, "99.0.0")).rejects.toThrow("Unsupported");
    });
    it("rejects truncated headers and excessive declared header lengths", async () => {
        await expect(decodeNativeMetadataSnapshot(new ArrayBuffer(3), version)).rejects.toThrow("header");
        const bytes = await encodeNativeMetadataSnapshot(snapshot());
        new DataView(bytes).setUint32(6, 0xffffffff, true);
        await expect(decodeNativeMetadataSnapshot(bytes, version)).rejects.toThrow("header");
    });
    it.each([1, 2 ** 31])("bounds decompression before accepting declared content size %s", async (size) => {
        const bytes = await encodeNativeMetadataSnapshot(snapshot());
        const length = new DataView(bytes).getUint32(6, true);
        const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 10, length))) as { bytes: number };
        header.bytes = size;
        const encoded = new TextEncoder().encode(JSON.stringify(header));
        const changed = new Uint8Array(10 + encoded.length + bytes.byteLength - 10 - length);
        changed.set(new Uint8Array(bytes, 0, 6));
        new DataView(changed.buffer).setUint32(6, encoded.length, true);
        changed.set(encoded, 10);
        changed.set(new Uint8Array(bytes, 10 + length), 10 + encoded.length);
        await expect(decodeNativeMetadataSnapshot(changed.buffer, version)).rejects.toThrow(/bound/);
    });
    it.each([new Date("2000-01-01"), new Map([["a", 1]]), [undefined], Infinity])(
        "leaves non-JSON native values to the original loader: %s",
        async (value) => {
            await expect(encodeNativeMetadataSnapshot(snapshot({ a: value }))).rejects.toThrow("original loader");
        }
    );
    it("rejects unsafe snapshot keys", async () => {
        await expect(encodeNativeMetadataSnapshot(snapshot({ constructor: { v: 1 } }))).rejects.toThrow(
            "original loader"
        );
    });
});

describe("the real IndexedDB preload boundary", () => {
    it("reuses cached rows without reading or changing their canonical values", async () => {
        const h = await fixture();
        h.create();
        const get = vi.spyOn(IDBObjectStore.prototype, "get");
        await h.host._preload();
        expect(h.host.rows).toEqual(rows);
        expect(get).not.toHaveBeenCalled();
        expect(await h.canonical()).toEqual(Object.values(rows));
        expect(Object.prototype.hasOwnProperty.call(h.host.db, "transaction")).toBe(false);
        expect(Object.getOwnPropertyDescriptor(h.host, "db")?.value).toBe(h.host.db);
    });
    it("merges missing records across cached pages without reusing a completed transaction", async () => {
        const native = { ...rows, b: { v: 1, headings: ["Synthetic new note"] }, d: { v: 1, tags: ["synthetic"] } };
        const h = await fixture(native);
        h.create();
        const get = vi.spyOn(IDBObjectStore.prototype, "get");
        await h.host._preload();
        expect(h.host.rows).toEqual(native);
        expect(get.mock.calls.map(([key]) => key)).toEqual(["b", "d"]);
        expect(await h.canonical()).toEqual([native.a, native.b, native.c, native.d]);
    });
    it("does not restore a snapshot record which the native store no longer holds", async () => {
        const h = await fixture({ a: rows.a });
        h.create();
        await h.host._preload();
        expect(h.host.rows).toEqual({ a: rows.a });
    });
    it("reopens the unchanged native store after a snapshot read fails, restoring its method descriptors", async () => {
        const h = await fixture();
        h.create();
        vi.spyOn(IDBObjectStore.prototype, "getAllKeys").mockImplementationOnce(() => {
            throw new Error("synthetic native read failure");
        });
        await h.host._preload();
        expect(h.host.rows).toEqual(rows);
        expect(Object.prototype.hasOwnProperty.call(h.host.db, "transaction")).toBe(false);
    });
    it("preserves native getAll callers which do not enumerate keys first", async () => {
        const h = await fixture();
        h.host.withoutKeys = true;
        h.create();
        await h.host._preload();
        expect(h.host.rows).toEqual({ all: Object.values(rows) });
    });
    it.each(["missing", "corrupt", "unreadable"])("uses native preload when the snapshot is %s", async (state) => {
        const h = await fixture();
        if (state === "missing") h.setBytes(null);
        if (state === "corrupt") h.setBytes(new ArrayBuffer(4));
        if (state === "unreadable") h.io.readMetadataSnapshot.mockRejectedValue(new Error("synthetic read failure"));
        const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
        h.create();
        await h.host._preload();
        expect(h.host.rows).toEqual(rows);
        expect(getAll).toHaveBeenCalled();
        expect(h.io.writeMetadataSnapshot).not.toHaveBeenCalled();
    });
    it("restores the original preload on unload and does not install it twice", async () => {
        const h = await fixture(),
            original = h.host._preload;
        h.create();
        const wrapped = h.host._preload;
        h.create();
        expect(h.host._preload).toBe(wrapped);
        h.stop();
        expect(h.host._preload).toBe(original);
        await h.host._preload();
        expect(h.host.rows).toEqual(rows);
    });
    it("does not replace an original getter-only database boundary", async () => {
        const h = await fixture();
        let selected: NativeMetadataDatabase | null = null;
        Object.defineProperty(h.host, "db", {
            configurable: true,
            get: () => selected,
            set: (value: NativeMetadataDatabase | null) => {
                selected = value;
            },
        });
        const before = Object.getOwnPropertyDescriptor(h.host, "db");
        h.create();
        await h.host._preload();
        expect(h.host.rows).toEqual(rows);
        expect(Object.getOwnPropertyDescriptor(h.host, "db")).toEqual(before);
    });
    it("captures a canonical snapshot explicitly without changing native records", async () => {
        const h = await fixture();
        await h.host._preload();
        const component = h.create();
        expect(await component.prepare()).toBe(true);
        expect(h.io.writeMetadataSnapshot).toHaveBeenCalledOnce();
        expect(await decodeNativeMetadataSnapshot(h.io.writeMetadataSnapshot.mock.calls[0][0], version)).toEqual(
            snapshot()
        );
        expect(await h.canonical()).toEqual(Object.values(rows));
    });
    it("refuses preparation while native indexing is active or the component is unloaded", async () => {
        const h = await fixture();
        await h.host._preload();
        const component = h.create();
        h.host.inProgressTaskCount = 1;
        expect(await component.prepare()).toBe(false);
        h.host.inProgressTaskCount = 0;
        h.stop();
        expect(await component.prepare()).toBe(false);
        expect(h.io.writeMetadataSnapshot).not.toHaveBeenCalled();
    });
    it("waits for a preparation already in flight during unload", async () => {
        const h = await fixture();
        await h.host._preload();
        const component = h.create();
        let finish!: () => void;
        h.io.writeMetadataSnapshot.mockImplementationOnce(
            async () =>
                await new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        const preparing = component.prepare();
        await vi.waitFor(() => expect(h.io.writeMetadataSnapshot).toHaveBeenCalledOnce());
        h.stop();
        let ended = false;
        const stopping = component.waitForPreparation().then(() => {
            ended = true;
        });
        await Promise.resolve();
        expect(ended).toBe(false);
        finish();
        await stopping;
        expect(await preparing).toBe(false);
    });
    it("does not run background snapshot work without an idle lifecycle decision", async () => {
        const h = await fixture();
        h.setBytes(null);
        const component = h.create();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await h.host._preload();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.io.writeMetadataSnapshot).not.toHaveBeenCalled();
        component.requestPreparation();
        h.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("performs at most one scheduled snapshot when the lifecycle permits maintenance", async () => {
        const h = await fixture();
        h.setBytes(null);
        const component = h.create(() => true);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await h.host._preload();
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(h.io.writeMetadataSnapshot).toHaveBeenCalledOnce());
        await component.waitForPreparation();
        component.requestPreparation();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.io.writeMetadataSnapshot).toHaveBeenCalledOnce();
    });
});
