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
] as const satisfies readonly (keyof ObsidianLiveSyncSettings)[];

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
    const sanitized: Partial<ObsidianLiveSyncSettings> = { ...data };
    for (const field of MARKDOWN_CREDENTIAL_FIELDS) delete sanitized[field];
    return sanitized;
}
