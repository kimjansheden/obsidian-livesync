import { DEFAULT_SETTINGS, type ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { describe, expect, it } from "vitest";
import {
    buildSettingsFromMarkdown,
    containsMarkdownCredentialFields,
    isSafeSettingsDocument,
    isSafeSettingSyncFilePath,
    prepareSettingsForPersistence,
    sanitizeSettingsForMarkdown,
} from "./settingsPersistence";

const settings = (patch: Partial<ObsidianLiveSyncSettings> = {}): ObsidianLiveSyncSettings => ({
    ...DEFAULT_SETTINGS,
    ...patch,
});

describe("sanitizeSettingsForMarkdown", () => {
    it.each([false, true])("removes every credential field when the legacy sync flag is %s", (writeCredentials) => {
        const input = settings({
            writeCredentialsForSettingSync: writeCredentials,
            encryptedCouchDBConnection: "%synthetic-connection-ciphertext",
            encryptedPassphrase: "%synthetic-passphrase-ciphertext",
            couchDB_USER: "synthetic-user",
            couchDB_PASSWORD: "synthetic-password",
            passphrase: "synthetic-passphrase",
            jwtKey: "synthetic-jwt-key",
            couchDB_CustomHeaders: "Authorization: synthetic-token",
            bucketCustomHeaders: "X-Api-Key: synthetic-key",
            accessKey: "SYNTHETICACCESSKEY",
            secretKey: "synthetic-secret-key",
        });

        const output = sanitizeSettingsForMarkdown(input);
        const serialized = JSON.stringify(output);

        expect(serialized).not.toContain("synthetic");
        expect(output.writeCredentialsForSettingSync).toBe(writeCredentials);
        expect(input.accessKey).toBe("SYNTHETICACCESSKEY");
    });

    it("removes nested credentials and complete remote configurations", () => {
        const input = settings({
            nestedSafeSetting: {
                enabled: true,
                accessKey: "SYNTHETICACCESSKEY",
                deeper: { secret: "synthetic-secret" },
            },
            remoteConfigurations: {
                synthetic: {
                    id: "synthetic",
                    name: "Synthetic",
                    uri: "https://user:password@example.invalid",
                    isEncrypted: false,
                },
            },
        } as Partial<ObsidianLiveSyncSettings>);

        const output = sanitizeSettingsForMarkdown(input);

        expect(output).toMatchObject({ nestedSafeSetting: { enabled: true, deeper: {} } });
        expect(output).not.toHaveProperty("remoteConfigurations");
        expect(JSON.stringify(output)).not.toContain("synthetic");
        expect(containsMarkdownCredentialFields(output)).toBe(false);
    });

    it("detects credential fields at any nesting depth without inspecting values", () => {
        expect(
            containsMarkdownCredentialFields({
                safe: [{ nested: { clientSecret: "synthetic-secret" } }],
            })
        ).toBe(true);
        expect(containsMarkdownCredentialFields({ P2P_turnCredential: "synthetic-credential" })).toBe(true);
        expect(containsMarkdownCredentialFields({ enabled: true, path: ".obsidian/app.json" })).toBe(false);
    });

    it("accepts only credential-free object documents", () => {
        expect(isSafeSettingsDocument({ enabled: true })).toBe(true);
        expect(isSafeSettingsDocument([{ enabled: true }])).toBe(false);
        expect(isSafeSettingsDocument({ nested: { password: "synthetic-password" } })).toBe(false);
        expect(isSafeSettingsDocument({ remoteConfigurations: {} })).toBe(false);
    });

    it("keeps the receiving device's connection and remote selection when a document is applied", () => {
        const local = settings({
            accessKey: "SYNTHETICLOCALACCESSKEY",
            secretKey: "synthetic-local-secret",
            endpoint: "https://local.example.invalid",
            bucket: "synthetic-local-bucket",
            encryptedPassphrase: "%synthetic-local-passphrase-ciphertext",
            remoteConfigurations: {
                local: { id: "local", name: "Local", uri: "%synthetic-local-uri", isEncrypted: true },
            },
            activeConfigurationId: "local",
            syncOnSave: false,
        } as Partial<ObsidianLiveSyncSettings>);
        const incoming = sanitizeSettingsForMarkdown(
            settings({
                accessKey: "SYNTHETICREMOTEACCESSKEY",
                endpoint: "https://remote.example.invalid",
                activeConfigurationId: "remote",
                syncOnSave: true,
            })
        );

        const applied = buildSettingsFromMarkdown(local, incoming);

        expect(applied.syncOnSave).toBe(true);
        expect(applied.accessKey).toBe(local.accessKey);
        expect(applied.secretKey).toBe(local.secretKey);
        expect(applied.endpoint).toBe(local.endpoint);
        expect(applied.bucket).toBe(local.bucket);
        expect(applied.encryptedPassphrase).toBe(local.encryptedPassphrase);
        expect(applied.remoteConfigurations).toEqual(local.remoteConfigurations);
        expect(applied.activeConfigurationId).toBe("local");
    });

    it("keeps the receiving device's values for fields a partial document omits", () => {
        const local = settings({
            remoteType: "MINIO",
            bucketPrefix: "synthetic-local/",
            encrypt: true,
            usePathObfuscation: true,
            syncOnSave: false,
        } as Partial<ObsidianLiveSyncSettings>);

        const applied = buildSettingsFromMarkdown(local, { syncOnSave: true });

        expect(applied).toMatchObject({
            remoteType: "MINIO",
            bucketPrefix: "synthetic-local/",
            encrypt: true,
            usePathObfuscation: true,
            syncOnSave: true,
        });
    });

    it("accepts only visible Markdown notes as settings sync files", () => {
        expect(isSafeSettingSyncFilePath("settings/livesync.md")).toBe(true);
        for (const path of [
            ".obsidian/app.json",
            ".obsidian/livesync.md",
            "notes/.hidden/livesync.md",
            "../livesync.md",
            "/livesync.md",
            "notes//livesync.md",
            "livesync.json",
        ]) {
            expect(isSafeSettingSyncFilePath(path), path).toBe(false);
        }
    });
});

describe("prepareSettingsForPersistence", () => {
    it("preserves credential-free settings", () => {
        const input = settings({ isConfigured: true });
        const result = prepareSettingsForPersistence(input);

        expect(result).toEqual(input);
        expect(result).not.toBe(input);
    });

    it.each([
        ["couchDB_PASSWORD", { couchDB_PASSWORD: "synthetic-password" }],
        ["accessKey", { accessKey: "SYNTHETICACCESSKEY" }],
        ["secretKey", { secretKey: "synthetic-secret-key" }],
        ["passphrase", { passphrase: "synthetic-passphrase" }],
    ] as const)("rejects an unencrypted %s without exposing its value", (field, patch) => {
        expect(() => prepareSettingsForPersistence(settings(patch))).toThrow(field);
        expect(() => prepareSettingsForPersistence(settings(patch))).not.toThrow(/synthetic-/i);
    });

    it("rejects primary plaintext credentials even when an older encrypted blob exists", () => {
        expect(() =>
            prepareSettingsForPersistence(
                settings({
                    encryptedCouchDBConnection: "%synthetic-ciphertext",
                    accessKey: "SYNTHETICACCESSKEY",
                })
            )
        ).toThrow("accessKey");
    });

    it("scrubs auxiliary credentials represented by the encrypted connection without mutating memory", () => {
        const input = settings({
            encryptedCouchDBConnection: "%synthetic-ciphertext",
            couchDB_CustomHeaders: "Authorization: synthetic-token",
            bucketCustomHeaders: "X-Api-Key: synthetic-key",
            jwtKey: "synthetic-jwt-key",
            jwtKid: "synthetic-kid",
            jwtSub: "synthetic-sub",
        });

        const result = prepareSettingsForPersistence(input);

        expect(result.couchDB_CustomHeaders).toBe("");
        expect(result.bucketCustomHeaders).toBe("");
        expect(result.jwtKey).toBe("");
        expect(result.jwtKid).toBe("");
        expect(result.jwtSub).toBe("");
        expect(input.jwtKey).toBe("synthetic-jwt-key");
    });

    it("rejects auxiliary credentials when no encrypted connection exists", () => {
        expect(() => prepareSettingsForPersistence(settings({ jwtKey: "synthetic-jwt-key" }))).toThrow("jwtKey");
    });

    it("rejects unencrypted remote configuration URIs and permits encrypted ones", () => {
        const remote = {
            id: "synthetic",
            name: "Synthetic",
            uri: "https://user:password@example.invalid",
            isEncrypted: false,
        };
        expect(() => prepareSettingsForPersistence(settings({ remoteConfigurations: { synthetic: remote } }))).toThrow(
            "remoteConfigurations.synthetic.uri"
        );

        const encrypted = { ...remote, uri: "%synthetic-ciphertext", isEncrypted: true };
        expect(
            prepareSettingsForPersistence(settings({ remoteConfigurations: { synthetic: encrypted } }))
                .remoteConfigurations
        ).toEqual({ synthetic: encrypted });
    });
});
