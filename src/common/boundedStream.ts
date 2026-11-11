/** Consume a byte stream without accepting more than its declared bound. */
export async function readBoundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<ArrayBuffer> {
    const reader = stream.getReader(),
        chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > limit) throw new Error("Byte stream exceeds its size bound");
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
