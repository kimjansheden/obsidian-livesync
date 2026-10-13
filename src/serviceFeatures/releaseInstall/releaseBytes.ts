/**
 * Byte helpers shared by the release package verifier, the trusted-keys parser and the installer.
 * They depend on nothing but WebCrypto and the standard encoders, so they keep working after the plug-in unloads.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PADDING = 61; // "="
const BASE64_VALUES = (() => {
    const values = new Int8Array(128).fill(-1);
    for (let index = 0; index < BASE64_ALPHABET.length; index++) values[BASE64_ALPHABET.charCodeAt(index)] = index;
    return values;
})();

/**
 * Decode standard base64 with padding.
 * @returns The bytes, or `null` unless the text is exactly what encoding those bytes produces. One byte sequence
 * therefore has a single accepted spelling: no line breaks, no missing padding, no other alphabet, and no stray
 * bits in the last character.
 */
export function decodeCanonicalBase64(text: unknown): Uint8Array<ArrayBuffer> | null {
    if (typeof text !== "string" || text.length % 4 !== 0) return null;
    const length = text.length;
    let padding = 0;
    if (length > 0 && text.charCodeAt(length - 1) === BASE64_PADDING) padding++;
    if (length > 1 && text.charCodeAt(length - 2) === BASE64_PADDING) padding++;
    const bytes = new Uint8Array((length / 4) * 3 - padding);
    const valueAt = (index: number) => {
        const code = text.charCodeAt(index);
        return code < 128 ? BASE64_VALUES[code] : -1;
    };
    let offset = 0;
    for (let index = 0; index < length; index += 4) {
        const last = index + 4 === length;
        const a = valueAt(index);
        const b = valueAt(index + 1);
        const c = last && padding === 2 ? 0 : valueAt(index + 2);
        const d = last && padding >= 1 ? 0 : valueAt(index + 3);
        if (a < 0 || b < 0 || c < 0 || d < 0) return null;
        // Bits which no byte uses must be zero, or another spelling would decode to the same bytes.
        if (last && padding === 2 && (b & 0x0f) !== 0) return null;
        if (last && padding === 1 && (c & 0x03) !== 0) return null;
        const quantum = (a << 18) | (b << 12) | (c << 6) | d;
        if (offset < bytes.length) bytes[offset++] = (quantum >> 16) & 0xff;
        if (offset < bytes.length) bytes[offset++] = (quantum >> 8) & 0xff;
        if (offset < bytes.length) bytes[offset++] = quantum & 0xff;
    }
    return bytes;
}

/** Decode UTF-8 strictly: malformed input throws instead of being replaced. A leading byte order mark is dropped. */
export function decodeStrictUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function sha256Hex(subtle: SubtleCrypto, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    let hex = "";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether `value` has exactly the own enumerable keys `keys`, no more and no fewer. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return (
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
}

/**
 * Every position at which the ASCII text `needle` occurs in `bytes`, without overlap.
 * The search is over bytes, so content which is not text does not hide an occurrence.
 */
export function findAsciiOccurrences(bytes: Uint8Array, needle: string): number[] {
    const positions: number[] = [];
    if (needle.length === 0) return positions;
    const first = needle.charCodeAt(0);
    let from = 0;
    for (;;) {
        const start = bytes.indexOf(first, from);
        if (start < 0 || start + needle.length > bytes.length) return positions;
        let matches = true;
        for (let index = 1; index < needle.length && matches; index++) {
            matches = bytes[start + index] === needle.charCodeAt(index);
        }
        if (matches) positions.push(start);
        from = matches ? start + needle.length : start + 1;
    }
}
