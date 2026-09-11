import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { NecessaryServices } from "@vrtmrz/livesync-commonlib/compat/interfaces/ServiceModule";
import { createInstanceLogFunction, type LogFunction } from "@vrtmrz/livesync-commonlib/compat/services/lib/logUtils";

type DeviceIdentityHost = NecessaryServices<"API" | "setting", never>;

function randomSuffix(length = 4) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Journal upload needs a device-local synchronisation identity. Setup URI, QR code and P2P imports
 * deliberately leave the source device's name behind, so a joined device starts without one and
 * every upload fails. Give a configured device without a name a generated one. It stays on this
 * device and can be renamed in Customisation sync.
 * @returns The assigned name, or undefined when the device already has one or is not configured.
 */
export function ensureDeviceSynchronisationIdentity(host: DeviceIdentityHost, log: LogFunction): string | undefined {
    const setting = host.services.setting;
    if (!setting.currentSettings().isConfigured) return undefined;
    if ((setting.getDeviceAndVaultName() ?? "").trim() !== "") return undefined;
    const name = `${host.services.API.getPlatform()}-${randomSuffix()}`;
    try {
        setting.setDeviceAndVaultName(name);
        setting.saveDeviceAndVaultName();
    } catch (ex) {
        // Loading must go on. If only saving failed, the name lasts for this session and the next launch generates another.
        log("Could not store a generated device name.", LOG_LEVEL_NOTICE);
        log(ex, LOG_LEVEL_VERBOSE);
        return undefined;
    }
    log(
        `This device had no device name, so it is now called "${name}". You can change it in Customisation sync.`,
        LOG_LEVEL_NOTICE
    );
    return name;
}

export function useDeviceSynchronisationIdentity(host: NecessaryServices<"API" | "setting" | "appLifecycle", never>) {
    const log = createInstanceLogFunction("SF:DeviceIdentity", host.services.API);
    host.services.appLifecycle.onSettingLoaded.addHandler(() => {
        ensureDeviceSynchronisationIdentity(host, log);
        return Promise.resolve(true);
    });
}
