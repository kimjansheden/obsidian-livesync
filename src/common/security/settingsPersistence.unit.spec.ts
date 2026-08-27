import { DEFAULT_SETTINGS, type ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { describe, expect, it } from "vitest";
import { prepareSettingsForPersistence, sanitizeSettingsForMarkdown } from "./settingsPersistence";

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
