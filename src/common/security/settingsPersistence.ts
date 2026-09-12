import type { ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";

const CONNECTION_FIELDS_REQUIRING_ENCRYPTION = [
    "couchDB_URI",
    "couchDB_USER",
    "couchDB_PASSWORD",
    "couchDB_DBNAME",
    "accessKey",
    "secretKey",
    "bucket",
    "endpoint",
] as const satisfies readonly (keyof ObsidianLiveSyncSettings)[];

const MARKDOWN_CREDENTIAL_FIELDS = [
    "encryptedCouchDBConnection",
    "encryptedPassphrase",
    "additionalSuffixOfDatabaseName",
    "couchDB_USER",
    "couchDB_PASSWORD",
    "passphrase",
    "jwtKey",
    "jwtKid",
    "jwtSub",
    "couchDB_CustomHeaders",
    "bucketCustomHeaders",
    "accessKey",
    "secretKey",
    "couchDB_URI",
    "couchDB_DBNAME",
    "bucket",
    "endpoint",
] as const satisfies readonly (keyof ObsidianLiveSyncSettings)[];

const MARKDOWN_CREDENTIAL_FIELD_NAMES = new Set(
    [
        ...MARKDOWN_CREDENTIAL_FIELDS,
        "apiKey",
        "clientSecret",
        "configurationPassphrase",
        "credential",
        "e2eePassphrase",
        "headers",
        "password",
        "secret",
        "token",
        "username",
    ].map((field) => field.replace(/[^a-z0-9]/gi, "").toLowerCase())
);
const MARKDOWN_CREDENTIAL_CONTAINER_NAMES = new Set(["remoteconfigurations"]);
// These select entries in the excluded remote configurations, so they must refer to the receiving device's own entries.
const MARKDOWN_LOCAL_REFERENCE_FIELDS = new Set<string>([
    "activeConfigurationId",
    "P2P_ActiveRemoteConfigurationId",
] satisfies readonly (keyof ObsidianLiveSyncSettings)[]);

const CONNECTION_FIELDS_TO_SCRUB = [
    "couchDB_CustomHeaders",
    "bucketCustomHeaders",
    "jwtKey",
    "jwtKid",
    "jwtSub",
] as const satisfies readonly (keyof ObsidianLiveSyncSettings)[];

function hasText(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function failUnsafePersistence(paths: readonly string[]): never {
    throw new Error(`Refusing to persist settings with unencrypted credential fields: ${paths.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFieldName(field: string): string {
    return field.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isMarkdownCredentialFieldName(normalized: string): boolean {
    return (
        MARKDOWN_CREDENTIAL_FIELD_NAMES.has(normalized) ||
        normalized.endsWith("accesskey") ||
        normalized.endsWith("apikey") ||
        normalized.endsWith("credential") ||
        normalized.endsWith("password") ||
        normalized.endsWith("passphrase") ||
        normalized.endsWith("secret") ||
        normalized.endsWith("secretkey") ||
        normalized.endsWith("token") ||
        normalized.endsWith("username")
    );
}

function isMarkdownExcludedField(field: string): boolean {
    const normalized = normalizedFieldName(field);
    return isMarkdownCredentialFieldName(normalized) || MARKDOWN_CREDENTIAL_CONTAINER_NAMES.has(normalized);
}

function containsMarkdownCredentialFieldsInValue(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(containsMarkdownCredentialFieldsInValue);
    if (!isRecord(value)) return false;

    return Object.entries(value).some(
        ([key, nestedValue]) => isMarkdownExcludedField(key) || containsMarkdownCredentialFieldsInValue(nestedValue)
    );
}

function sanitizeMarkdownValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeMarkdownValue);
    if (!isRecord(value)) return value;

    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        if (isMarkdownExcludedField(key)) continue;
        sanitized[key] = sanitizeMarkdownValue(nestedValue);
    }
    return sanitized;
}

/** Return whether an arbitrary settings document contains credential-bearing fields. */
export function containsMarkdownCredentialFields(value: unknown): boolean {
    return containsMarkdownCredentialFieldsInValue(value);
}

/** Narrow parsed Markdown settings to a credential-free object before applying it. */
export function isSafeSettingsDocument(value: unknown): value is Partial<ObsidianLiveSyncSettings> {
    return isRecord(value) && !containsMarkdownCredentialFieldsInValue(value);
}

function pickReceivingDeviceSettings(local: ObsidianLiveSyncSettings): Partial<ObsidianLiveSyncSettings> {
    return Object.fromEntries(
        Object.entries(local).filter(
            ([key]) => isMarkdownExcludedField(key) || MARKDOWN_LOCAL_REFERENCE_FIELDS.has(key)
        )
    );
}

/**
 * Build the settings to apply from a credential-free Markdown document.
 *
 * Fields the document omits keep the receiving device's values. Fields that
 * Markdown never carries - credentials, remote configurations and the active
 * remote selection - always stay local instead of being reset to defaults.
 */
export function buildSettingsFromMarkdown(
    local: ObsidianLiveSyncSettings,
    incoming: Partial<ObsidianLiveSyncSettings>
): ObsidianLiveSyncSettings {
    return { ...local, ...incoming, ...pickReceivingDeviceSettings(local) };
}

/** Return whether a settings Markdown path is a visible vault note rather than a hidden or configuration file. */
export function isSafeSettingSyncFilePath(path: string): boolean {
    if (!path.toLowerCase().endsWith(".md")) return false;
    return path.split(/[\\/]/).every((segment) => segment !== "" && !segment.startsWith("."));
}

/**
 * Return a persistence-safe copy of LiveSync settings.
 *
 * Commonlib normally encrypts connection settings before calling a host's
 * persistence adapter. This boundary is deliberately fail-closed if those
 * primary fields are still populated. Auxiliary credential fields that are
 * already represented by the encrypted connection blob are removed from the
 * persisted copy because older Commonlib versions did not clear all of them.
 */
export function prepareSettingsForPersistence(data: ObsidianLiveSyncSettings): ObsidianLiveSyncSettings {
    const prepared: ObsidianLiveSyncSettings = {
        ...data,
        remoteConfigurations: Object.fromEntries(
            Object.entries(data.remoteConfigurations ?? {}).map(([id, config]) => [id, { ...config }])
        ),
    };
    const unsafePaths: string[] = [];

    for (const field of CONNECTION_FIELDS_REQUIRING_ENCRYPTION) {
        if (hasText(prepared[field])) unsafePaths.push(field);
    }

    if (hasText(prepared.passphrase)) unsafePaths.push("passphrase");

    const hasEncryptedConnection = hasText(prepared.encryptedCouchDBConnection);
    for (const field of CONNECTION_FIELDS_TO_SCRUB) {
        if (!hasText(prepared[field])) continue;
        if (!hasEncryptedConnection) unsafePaths.push(field);
        else prepared[field] = "";
    }

    for (const [id, config] of Object.entries(prepared.remoteConfigurations ?? {})) {
        if (hasText(config.uri) && !config.isEncrypted) unsafePaths.push(`remoteConfigurations.${id}.uri`);
    }

    if (unsafePaths.length > 0) failUnsafePersistence(unsafePaths);
    return prepared;
}

/** Return a copy that is safe to place in a Markdown document. */
export function sanitizeSettingsForMarkdown(data: ObsidianLiveSyncSettings): Partial<ObsidianLiveSyncSettings> {
    return sanitizeMarkdownValue(data) as Partial<ObsidianLiveSyncSettings>;
}
