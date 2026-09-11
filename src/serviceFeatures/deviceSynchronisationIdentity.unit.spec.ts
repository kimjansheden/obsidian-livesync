import { describe, expect, it, vi } from "vitest";
import { ensureDeviceSynchronisationIdentity, useDeviceSynchronisationIdentity } from "./deviceSynchronisationIdentity";

function createHost({ isConfigured = true, name = "" } = {}) {
    let deviceName = name;
    const saveDeviceAndVaultName = vi.fn();
    const onSettingLoaded = { addHandler: vi.fn() };
    const host = {
        services: {
            API: { getPlatform: vi.fn(() => "android-app"), addLog: vi.fn() },
            setting: {
                currentSettings: vi.fn(() => ({ isConfigured })),
                getDeviceAndVaultName: vi.fn(() => deviceName),
                setDeviceAndVaultName: vi.fn((value: string) => {
                    deviceName = value;
                }),
                saveDeviceAndVaultName,
            },
            appLifecycle: { onSettingLoaded },
        },
    } as any;
    return { host, saveDeviceAndVaultName, onSettingLoaded, deviceName: () => deviceName };
}

describe("device synchronisation identity", () => {
    it("gives a configured device without a name a generated device-local name", () => {
        const { host, saveDeviceAndVaultName, deviceName } = createHost();
        const log = vi.fn();

        const assigned = ensureDeviceSynchronisationIdentity(host, log);

        expect(assigned).toMatch(/^android-app-[a-z0-9]{4}$/);
        expect(deviceName()).toBe(assigned);
        expect(saveDeviceAndVaultName).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledOnce();
    });

    it("keeps a name the device already has", () => {
        const { host, saveDeviceAndVaultName, deviceName } = createHost({ name: "pixel-notes" });

        expect(ensureDeviceSynchronisationIdentity(host, vi.fn())).toBeUndefined();

        expect(deviceName()).toBe("pixel-notes");
        expect(saveDeviceAndVaultName).not.toHaveBeenCalled();
    });

    it("leaves an unconfigured device to onboarding", () => {
        const { host, saveDeviceAndVaultName, deviceName } = createHost({ isConfigured: false });

        expect(ensureDeviceSynchronisationIdentity(host, vi.fn())).toBeUndefined();

        expect(deviceName()).toBe("");
        expect(saveDeviceAndVaultName).not.toHaveBeenCalled();
    });

    it("assigns the name once settings have loaded", async () => {
        const { host, onSettingLoaded, deviceName } = createHost();

        useDeviceSynchronisationIdentity(host);
        const handler = onSettingLoaded.addHandler.mock.calls[0][0] as () => Promise<boolean>;

        await expect(handler()).resolves.toBe(true);
        expect(deviceName()).toMatch(/^android-app-[a-z0-9]{4}$/);
    });

    it("keeps loading when the generated name cannot be stored", async () => {
        const { host, onSettingLoaded, saveDeviceAndVaultName } = createHost();
        saveDeviceAndVaultName.mockImplementation(() => {
            throw new Error("storage quota exceeded");
        });

        useDeviceSynchronisationIdentity(host);
        const handler = onSettingLoaded.addHandler.mock.calls[0][0] as () => Promise<boolean>;

        await expect(handler()).resolves.toBe(true);
    });
});
