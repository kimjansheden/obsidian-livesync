export type MergeableJsonValue = Record<string, unknown>;
export type SelectableJsonValue = MergeableJsonValue | unknown[];

function isValidJson(json: string): boolean {
    try {
        JSON.parse(json);
        return true;
    } catch {
        return false;
    }
}

/** Return an object or array revision that can be kept as a whole, or false when it cannot. */
export function parseSelectableJsonDocument(json: string): SelectableJsonValue | false {
    try {
        const value: unknown = JSON.parse(json);
        if (value === null || typeof value !== "object") return false;
        return value as SelectableJsonValue;
    } catch {
        return false;
    }
}

/** Only objects are merged field by field; arrays can only be kept as a whole revision. */
export function isMergeableJsonValue(value: unknown): value is MergeableJsonValue {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMergeableJsonDocument(json: string): MergeableJsonValue | false {
    const value = parseSelectableJsonDocument(json);
    return value !== false && isMergeableJsonValue(value) ? value : false;
}

export function isMergeableJsonDocument(json: string): boolean {
    return parseMergeableJsonDocument(json) !== false;
}

/** Return whether an incoming JSON file must not replace a local file that is valid JSON while it is not. */
export function shouldKeepValidLocalJson(path: string, incoming: string, local: string | null): boolean {
    return path.endsWith(".json") && local !== null && isValidJson(local) && !isValidJson(incoming);
}
