import { requireApiVersion, type App } from "@/deps.ts";
import type { DeviceLocalStorage } from "./releaseInstallRecords";

/**
 * Storage which belongs to this vault on this device and is never synchronised.
 * It lives in the app, not in the plug-in, so it stays usable after the plug-in has unloaded.
 * @returns `undefined` where the app does not offer it.
 */
export function deviceLocalStorageOf(app: App, key: string): DeviceLocalStorage | undefined {
    if (requireApiVersion("1.8.7")) {
        return {
            load: () => app.loadLocalStorage(key) as unknown,
            save: (value) => app.saveLocalStorage(key, value),
        };
    }
    return undefined;
}
