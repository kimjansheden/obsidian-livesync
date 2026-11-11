import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimeReader } from "./LocalRuntimeReader";

const directory = ".obsidian/plugins/example-plugin",
    asset = `${directory}/release-runtime/${"a".repeat(64)}.livesync-release`;
afterEach(() => vi.unstubAllGlobals());
function fixture() {
    const adapter = {
        readBinary: vi.fn(async () => new Uint8Array([9]).buffer),
        getResourcePath: vi.fn(
            (path: string) => `https://localhost/_capacitor_file_/storage/emulated/0/Synthetic/${path}`
        ),
    };
    const fetchLocal = vi.fn(
        async (_resource: string, _options?: RequestInit) => new Response(new Uint8Array([1, 2, 3]).buffer)
    );
    vi.stubGlobal("window", { fetch: fetchLocal });
    return { adapter, fetchLocal, reader: new LocalRuntimeReader(adapter, directory) };
}
describe("owned local runtime asset reads", () => {
    it.each([asset, `${directory}/trusted-release-keys.json`])(
        "streams owned asset %s without bridge copies or stale cache",
        async (path) => {
            const h = fixture();
            expect(new Uint8Array(await h.reader.read(path))).toEqual(new Uint8Array([1, 2, 3]));
            expect(h.adapter.readBinary).not.toHaveBeenCalled();
            expect(h.fetchLocal).toHaveBeenCalledWith(
                h.adapter.getResourcePath(path),
                expect.objectContaining({ cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) })
            );
            expect(h.reader.hasPendingReads).toBe(false);
        }
    );
    it.each([
        `${directory}/data.json`,
        `${directory}/release-runtime/../other.json`,
        ".obsidian/plugins/another-plugin/main.js",
    ])("keeps ordinary adapter semantics for %s", async (path) => {
        const h = fixture();
        await h.reader.read(path);
        expect(h.adapter.readBinary).toHaveBeenCalledWith(path);
        expect(h.fetchLocal).not.toHaveBeenCalled();
    });
    it.each(["https://example.invalid/runtime", "file:///private/runtime", "https://localhost/other/runtime"])(
        "does not fetch unsupported resource %s",
        async (uri) => {
            const h = fixture();
            h.adapter.getResourcePath.mockReturnValue(uri);
            await h.reader.read(asset);
            expect(h.fetchLocal).not.toHaveBeenCalled();
            expect(h.adapter.readBinary).toHaveBeenCalledOnce();
        }
    );
    it("rejects an unsuccessful local response without silently retrying the bridge", async () => {
        const h = fixture();
        h.fetchLocal.mockResolvedValue(new Response(null, { status: 404 }));
        await expect(h.reader.read(asset)).rejects.toThrow("could not be read");
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
        expect(h.reader.hasPendingReads).toBe(false);
    });
    it("bounds streamed bytes even without a declared content length and cancels the stream", async () => {
        const h = fixture(),
            cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array(16 * 1024 * 1024));
                c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            },
            cancel,
        });
        h.fetchLocal.mockResolvedValue(new Response(stream));
        await expect(h.reader.read(asset)).rejects.toThrow("size bound");
        expect(cancel).toHaveBeenCalledOnce();
        expect(h.reader.hasPendingReads).toBe(false);
    });
    it("aborts pending fetches, drains ownership and refuses late reads on stop", async () => {
        const h = fixture();
        h.fetchLocal.mockImplementation(
            (_resource, options) =>
                new Promise((_resolve, reject) =>
                    options?.signal?.addEventListener(
                        "abort",
                        () => reject(new DOMException("Synthetic cancellation", "AbortError")),
                        { once: true }
                    )
                )
        );
        const reading = h.reader.read(asset),
            rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
        expect(h.reader.hasPendingReads).toBe(true);
        h.reader.stop();
        await Promise.all([rejected, h.reader.waitForIdle()]);
        expect(h.reader.hasPendingReads).toBe(false);
        await expect(h.reader.read(asset)).rejects.toThrow("stopped");
    });
});
