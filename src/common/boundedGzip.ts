import { Gunzip } from "fflate";
import { readBoundedBytes } from "./boundedStream";

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value >>> 0;
});

/** Decode a single gzip member with an exact output bound on supported WebViews. */
export async function readBoundedGzip(
    encoded: Uint8Array<ArrayBuffer>,
    size: number
): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(size) || size < 0 || encoded.length < 18) throw new Error("Invalid bounded gzip size");
    const trailer = new DataView(encoded.buffer, encoded.byteOffset + encoded.length - 8, 8);
    if (trailer.getUint32(4, true) !== size) throw new Error("Gzip output size differs");
    if (typeof DecompressionStream === "function")
        return new Uint8Array(
            await readBoundedBytes(new Blob([encoded]).stream().pipeThrough(new DecompressionStream("gzip")), size)
        );
    const output = new Uint8Array(size);
    let length = 0,
        crc = 0xffffffff,
        complete = false;
    const decoder = new Gunzip((chunk, final) => {
        if (length + chunk.length > size) throw new Error("Gzip output exceeds its size bound");
        output.set(chunk, length);
        length += chunk.length;
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        complete ||= final;
    });
    decoder.onmember = () => {
        throw new Error("Concatenated gzip members are unsupported");
    };
    for (let offset = 0; offset < encoded.length; offset += 256)
        decoder.push(encoded.subarray(offset, offset + 256), offset + 256 >= encoded.length);
    if (!complete || length !== size || (crc ^ 0xffffffff) >>> 0 !== trailer.getUint32(0, true))
        throw new Error("Gzip output integrity differs");
    return output;
}
