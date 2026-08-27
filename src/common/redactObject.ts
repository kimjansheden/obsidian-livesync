const forbiddenPathSegments = new Set(["__proto__", "constructor", "prototype"]);

export function redactObject(obj: Record<string, unknown>, dotted: string, redactedValue = "REDACTED") {
    const keys = dotted.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (forbiddenPathSegments.has(key)) return obj;
        if (!Object.prototype.hasOwnProperty.call(current, key)) return obj;
        const next = current[key];
        if (typeof next !== "object" || next === null || Array.isArray(next)) return obj;
        current = next as Record<string, unknown>;
    }
    const lastKey = keys[keys.length - 1];
    if (forbiddenPathSegments.has(lastKey)) return obj;
    if (Object.prototype.hasOwnProperty.call(current, lastKey)) {
        current[lastKey] = redactedValue;
    }
    return obj;
}
