import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { encodeSettingsToSetupURI } from "@vrtmrz/livesync-commonlib/compat/API/processSetting";
import { encryptString } from "@vrtmrz/livesync-commonlib/compat/encryption/stringEncryption";
import { configURIBase } from "@/common/types";
import { DEVICE_LOCAL_SETUP_SETTING_KEYS, decryptSetupURISettings, isSetupURI } from "./setupUriPayload";

const passphrase = "synthetic-setup-passphrase-0001";
const deviceLocalKeys = [
    "additionalSuffixOfDatabaseName",
    "deviceAndVaultName",
    "P2P_DevicePeerName",
    "configPassphraseStore",
];

function sourceSettings(): ObsidianLiveSyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        isConfigured: true,
        remoteType: "MINIO",
        endpoint: "https://synthetic.example.invalid",
        bucket: "synthetic-bucket",
        bucketPrefix: "synthetic-prefix/",
        accessKey: "SYNTHETICACCESSKEY",
        secretKey: "synthetic-secret-key",
        passphrase: "synthetic-e2ee-passphrase",
        encrypt: true,
        usePathObfuscation: true,
        additionalSuffixOfDatabaseName: "source-app-id",
        P2P_DevicePeerName: "source-peer",
        deviceAndVaultName: "source-device",
        encryptedPassphrase: "%synthetic-local-ciphertext",
        encryptedCouchDBConnection: "%synthetic-local-connection",
        configPassphraseStore: "ASK_AT_LAUNCH",
    } as ObsidianLiveSyncSettings;
}

async function exportSetupURI(settings = sourceSettings()) {
    return (await encodeSettingsToSetupURI(
        settings,
        passphrase,
        ["pluginSyncExtendedSetting", ...DEVICE_LOCAL_SETUP_SETTING_KEYS],
        true
    )) as string;
}

describe("Setup URI payload", () => {
    it("carries the remote configuration but no device identity or local encrypted persistence", async () => {
        const uri = await exportSetupURI();

        expect(isSetupURI(uri)).toBe(true);
        const imported = await decryptSetupURISettings(uri, passphrase);

        expect(imported).toMatchObject({
            remoteType: "MINIO",
            endpoint: "https://synthetic.example.invalid",
            bucket: "synthetic-bucket",
            bucketPrefix: "synthetic-prefix/",
            passphrase: "synthetic-e2ee-passphrase",
            encrypt: true,
            usePathObfuscation: true,
        });
        for (const key of deviceLocalKeys) expect(imported).not.toHaveProperty(key);
        expect(imported.encryptedPassphrase).toBe("");
        expect(imported.encryptedCouchDBConnection).toBe("");
    });

    it("removes device identity from a Setup URI created by an older export", async () => {
        const uri = (await encodeSettingsToSetupURI(sourceSettings(), passphrase, [], true)) as string;

        const imported = await decryptSetupURISettings(uri, passphrase);

        for (const key of deviceLocalKeys) expect(imported).not.toHaveProperty(key);
    });

    it("rejects a wrong passphrase", async () => {
        const uri = await exportSetupURI();

        await expect(decryptSetupURISettings(uri, "synthetic-wrong-passphrase")).rejects.toThrow();
    });

    it("rejects tampered ciphertext because the encryption is authenticated", async () => {
        const uri = await exportSetupURI();
        const payload = decodeURIComponent(uri.substring(configURIBase.length).trim());
        const index = Math.floor(payload.length / 2);
        const replacement = payload[index] === "A" ? "B" : "A";
        const tampered = `${configURIBase}${encodeURIComponent(
            payload.slice(0, index) + replacement + payload.slice(index + 1)
        )}`;

        await expect(decryptSetupURISettings(tampered, passphrase)).rejects.toThrow();
    });

    it("rejects another URI target and an encrypted payload that is not a settings object", async () => {
        const uri = await exportSetupURI();
        const otherTarget = uri.replace(configURIBase, "obsidian://open?vault=");
        const arrayPayload = `${configURIBase}${encodeURIComponent(await encryptString("[1,2]", passphrase))}`;

        expect(isSetupURI(otherTarget)).toBe(false);
        await expect(decryptSetupURISettings(otherTarget, passphrase)).rejects.toThrow("Not a Setup URI");
        await expect(decryptSetupURISettings(arrayPayload, passphrase)).rejects.toThrow(
            "The Setup URI does not contain settings"
        );
    });
});
