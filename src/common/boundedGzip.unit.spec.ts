import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { readBoundedGzip } from "./boundedGzip";

afterEach(() => vi.unstubAllGlobals());
describe.each(["native", "fallback"])("bounded gzip %s decoding", (mode) => {
    const fixture = () => {
        if (mode === "fallback") vi.stubGlobal("DecompressionStream", undefined);
        const bytes = new TextEncoder().encode("Synthetic compressed payload. ".repeat(1500));
        return { bytes, encoded: new Uint8Array(gzipSync(bytes)) };
    };
    it("decodes the exact payload", async () => {
        const { bytes, encoded } = fixture();
        expect(await readBoundedGzip(encoded, bytes.length)).toEqual(bytes);
    });
    it("decodes an empty payload", async () => {
        fixture();
        expect(await readBoundedGzip(new Uint8Array(gzipSync(new Uint8Array())), 0)).toEqual(new Uint8Array());
    });
    it.each(["crc", "size", "overflow", "truncated", "negative"])("rejects %s", async (fault) => {
        const { bytes, encoded } = fixture();
        let size = bytes.length;
        if (fault === "crc") encoded[encoded.length - 8] ^= 1;
        if (fault === "size") size--;
        if (fault === "negative") size = -1;
        if (fault === "overflow") {
            size = 1;
            new DataView(encoded.buffer).setUint32(encoded.length - 4, size, true);
        }
        const input = fault === "truncated" ? encoded.subarray(0, encoded.length - 5) : encoded;
        await expect(readBoundedGzip(input, size)).rejects.toThrow();
    });
});
