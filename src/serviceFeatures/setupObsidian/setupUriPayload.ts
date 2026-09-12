import type { ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { decryptString } from "@vrtmrz/livesync-commonlib/compat/encryption/stringEncryption";
import { configURIBase } from "@/common/types";

/**
 * Settings that belong to one installation and must never move to another device through setup:
 * its database identity, its names, and how it protects its own stored settings.
 */
export const DEVICE_LOCAL_SETUP_SETTING_KEYS = [
    "additionalSuffixOfDatabaseName",
    "deviceAndVaultName",
    "P2P_DevicePeerName",
    "configPassphraseStore",
] as const satisfies readonly (keyof ObsidianLiveSyncSettings)[];

export type DeviceLocalSetupSettingKey = (typeof DEVICE_LOCAL_SETUP_SETTING_KEYS)[number];

/** Settings received from another device. Applying them keeps the receiver's device-local values. */
export type SettingsWithoutDeviceLocal<T extends Partial<ObsidianLiveSyncSettings> = ObsidianLiveSyncSettings> = Omit<
    T,
    DeviceLocalSetupSettingKey
>;

export function withoutDeviceLocalSettings<T extends Partial<ObsidianLiveSyncSettings>>(
    settings: T
): SettingsWithoutDeviceLocal<T> {
    const copy = { ...settings };
    for (const key of DEVICE_LOCAL_SETUP_SETTING_KEYS) delete copy[key];
    return copy;
}

export function isSetupURI(uri: string): boolean {
    return uri.startsWith(configURIBase);
}

/**
 * Decrypt a Setup URI into settings for this device.
 *
 * Throws for another URI scheme, a wrong passphrase, tampered ciphertext or a
 * payload that is not a settings object, so nothing is applied in those cases.
 */
export async function decryptSetupURISettings(uri: string, passphrase: string): Promise<SettingsWithoutDeviceLocal> {
    if (!isSetupURI(uri)) throw new Error("Not a Setup URI");
    const payload = decodeURIComponent(uri.substring(configURIBase.length).trim());
    const parsed: unknown = JSON.parse(await decryptString(payload, passphrase));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The Setup URI does not contain settings");
    }
    return withoutDeviceLocalSettings(parsed as ObsidianLiveSyncSettings);
}
