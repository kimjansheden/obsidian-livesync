/**
 * What a device remembers about release packages, so that a rejected package raises its notice once instead of at
 * every start, and a package whose build did not load is never installed again.
 *
 * The records live in storage which belongs to this vault on this device and is never synchronised. They are read
 * and written directly, without any of the plug-in's services, because the last of them is written after the
 * plug-in has unloaded itself.
 */
import { isPlainObject } from "./releaseBytes";
import type { FailedReleaseRecords } from "./releaseInstaller";

/** Synchronous storage local to this vault on this device, such as the host's local storage. */
export interface DeviceLocalStorage {
    load(): unknown;
    save(value: string): void;
}

export interface ReleaseInstallRecords extends FailedReleaseRecords {
    /** Whether the notice for this rejected package was already raised on this device. */
    hasNoticed(key: string): boolean;
    rememberNoticed(key: string): void;
    /** Whether the build of the package with this SHA-256 was loaded here and not accepted. */
    hasFailedToLoad(packageSha256: string): boolean;
}

/** Entries kept per list. The oldest is dropped first; forgetting one only repeats a notice or an attempt. */
export const MAX_RELEASE_INSTALL_RECORDS = 32;
const MAX_RECORD_LENGTH = 512;

interface StoredRecords {
    noticed: string[];
    failedToLoad: string[];
}

function readList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry): entry is string => typeof entry === "string" && entry.length <= MAX_RECORD_LENGTH)
        .slice(-MAX_RELEASE_INSTALL_RECORDS);
}

function read(storage: DeviceLocalStorage): StoredRecords {
    let stored: unknown;
    try {
        const raw = storage.load();
        stored = typeof raw === "string" ? JSON.parse(raw) : undefined;
    } catch {
        stored = undefined;
    }
    const records = isPlainObject(stored) ? stored : {};
    return { noticed: readList(records.noticed), failedToLoad: readList(records.failedToLoad) };
}

export function createReleaseInstallRecords(storage: DeviceLocalStorage): ReleaseInstallRecords {
    // A package whose build failed to load must never be tried again, but the host's local storage swallows its
    // write errors. So a package remembered this way is also held in memory for this session: even if the write
    // did not take, the running instance does not try it again. The read of `hasFailedToLoad` consults both.
    const failedToLoadThisSession = new Set<string>();
    // Read afresh every time, so that an instance which has loaded since does not have its entries overwritten.
    const remember = (list: keyof StoredRecords, entry: string): boolean => {
        const records = read(storage);
        if (records[list].includes(entry)) return true;
        records[list] = [...records[list], entry].slice(-MAX_RELEASE_INSTALL_RECORDS);
        try {
            storage.save(JSON.stringify(records));
        } catch {
            return false;
        }
        // Read it back: the host's storage may report no error yet not have kept the value.
        return read(storage)[list].includes(entry);
    };
    return {
        hasNoticed: (key) => read(storage).noticed.includes(key),
        rememberNoticed: (key) => void remember("noticed", key),
        hasFailedToLoad: (packageSha256) =>
            failedToLoadThisSession.has(packageSha256) || read(storage).failedToLoad.includes(packageSha256),
        rememberFailedToLoad: (packageSha256) => {
            // The session set is the fallback whether the write threw or silently did not persist.
            failedToLoadThisSession.add(packageSha256);
            remember("failedToLoad", packageSha256);
        },
    };
}
