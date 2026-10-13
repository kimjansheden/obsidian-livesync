/**
 * Finds release packages in the vault, verifies them, and installs the newest valid one once the plug-in is idle.
 *
 * Host-independent: everything it needs from the host comes through {@link ReleaseInstallPorts}.
 */
import { sha256Hex } from "./releaseBytes";
import {
    completeReleaseInstall,
    prepareReleaseInstall,
    type PreparedReleaseInstall,
    type ReleaseInstallEnvironment,
    type ReleaseInstallOutcome,
} from "./releaseInstaller";
import type { ReleaseInstallRecords } from "./releaseInstallRecords";
import {
    verifyReleasePackage,
    type ReleasePackageVerdict,
    type ReleaseVerificationContext,
    type VerifiedReleasePackage,
} from "./releasePackage";

/** A vault file with the release package extension. */
export interface ReleasePackageFile {
    path: string;
    /** The size which the host reports, without reading the file. */
    size: number;
    read(): Promise<Uint8Array<ArrayBuffer>>;
}

/** What may be in flight in the plug-in. An installation waits until none of it is. */
export interface ReleaseInstallActivity {
    /**
     * Whether the plug-in has finished loading and is operating. A package already in the vault when the plug-in
     * opens is seen at layout-ready, before the start-up scan and readiness; the swap must wait until then, or it
     * would unload the plug-in in the middle of its own start-up and no counter below would show that scan.
     */
    ready: boolean;
    /** Finite remote operations in progress, replication cycles among them, counted from their pre-flight on. */
    remoteActivities: number;
    /** Received documents being applied, and the sending started when a mobile app is hidden. */
    localApplicationActivities: number;
    /** Received documents queued, being stored into the database, or being written to storage. */
    replicationResults: number;
    /** Storage events queued, held back for batching, or being processed. */
    fileEvents: number;
    /** The state of the replicator; a continuous replication which is caught up reports itself as paused. */
    syncStatus: string;
    /** Whether this is a mobile app which is not visible, and so may be stopped at any moment. */
    hiddenOnMobile: boolean;
}

const TRANSFERRING_STATUSES: readonly string[] = ["STARTED", "CONNECTED", "JOURNAL_SEND", "JOURNAL_RECEIVE"];

/** Whether no replication is running, nothing waits to be stored or applied, and the app will not be stopped. */
export function isIdleForInstall(activity: ReleaseInstallActivity): boolean {
    return (
        activity.ready &&
        activity.remoteActivities === 0 &&
        activity.localApplicationActivities === 0 &&
        activity.replicationResults === 0 &&
        activity.fileEvents === 0 &&
        !TRANSFERRING_STATUSES.includes(activity.syncStatus) &&
        !activity.hiddenOnMobile
    );
}

export interface ReleaseInstallCoordinatorTimings {
    /**
     * Pauses before a package which does not parse is read again. A file which has just arrived may not be
     * complete yet, so it is rejected only when it still does not parse after the last pause.
     */
    incompleteRetryDelaysMs: readonly number[];
    /** Pause between two looks at whether the plug-in is idle. */
    idlePollMs: number;
    /** Package files above this size are refused without being read. */
    maxPackageBytes: number;
}

export const DEFAULT_RELEASE_INSTALL_COORDINATOR_TIMINGS: ReleaseInstallCoordinatorTimings = {
    incompleteRetryDelaysMs: [2_000, 5_000, 15_000],
    idlePollMs: 1_000,
    // A package is base64, about a third larger than the three files it holds. 32 MiB admits roughly 24 MiB of
    // files, several times the size of a built plug-in, while bounding what a malformed file can pull into memory.
    maxPackageBytes: 32 * 1024 * 1024,
};

export interface ReleaseInstallPorts {
    listPackageFiles(): ReleasePackageFile[];
    verification: ReleaseVerificationContext;
    records: ReleaseInstallRecords;
    /** Absent when the host cannot unload and load the plug-in, so that nothing could be reloaded and verified. */
    install: ReleaseInstallEnvironment | undefined;
    currentActivity(): ReleaseInstallActivity;
    /** Storage events which have arrived so far, also those not yet counted as queued. */
    storageEventCount(): number;
    hasUnloaded(): boolean;
    notify(message: string, lasting: boolean): void;
    log(message: string): void;
    wait(milliseconds: number): Promise<void>;
    timings: ReleaseInstallCoordinatorTimings;
}

interface Candidate {
    path: string;
    packageSha256: string;
    verified: VerifiedReleasePackage;
}

const INCOMPLETE_CODE = "invalid-json";

export class ReleaseInstallCoordinator {
    private scanning = false;
    private scanRequested = false;
    private installPending = false;
    /** Packages whose files could not be staged in this session. They are tried again at the next start. */
    private readonly notStagedThisSession = new Set<string>();
    private reloadUnavailableNoticed = false;

    constructor(private readonly ports: ReleaseInstallPorts) {}

    /**
     * Look at the package files in the vault. Requests made while a look is in progress are answered by one more
     * look afterwards.
     * @returns The outcome of the installation which this call completed, if any.
     */
    async scan(): Promise<ReleaseInstallOutcome | undefined> {
        this.scanRequested = true;
        if (this.scanning) return undefined;
        this.scanning = true;
        try {
            let outcome: ReleaseInstallOutcome | undefined;
            while (this.scanRequested && !this.installPending && !this.ports.hasUnloaded()) {
                this.scanRequested = false;
                outcome = await this.scanOnce();
            }
            return outcome;
        } finally {
            this.scanning = false;
        }
    }

    private async scanOnce(): Promise<ReleaseInstallOutcome | undefined> {
        const candidates: Candidate[] = [];
        for (const file of this.ports.listPackageFiles()) {
            try {
                const candidate = await this.examine(file);
                if (candidate) candidates.push(candidate);
            } catch (error) {
                this.ports.log(`Release package ${file.path} could not be examined: ${String(error)}`);
            }
        }
        if (candidates.length === 0) return undefined;
        // Among several valid packages newer than the running build, the highest release number is installed.
        const newest = candidates.reduce((best, candidate) =>
            candidate.verified.releaseNumber > best.verified.releaseNumber ? candidate : best
        );
        return await this.install(newest);
    }

    private noticeOnce(key: string, message: string): void {
        this.ports.log(message);
        if (this.ports.records.hasNoticed(key)) return;
        this.ports.notify(message, true);
        this.ports.records.rememberNoticed(key);
    }

    /**
     * Verify one package file.
     * @returns The package when it is valid, newer than the running build and not known to fail; nothing otherwise.
     */
    private async examine(file: ReleasePackageFile): Promise<Candidate | undefined> {
        const { timings, verification, records } = this.ports;
        if (file.size > timings.maxPackageBytes) {
            this.noticeOnce(
                `oversize:${file.size}:${file.path}`,
                `Release package ${file.path} was rejected: it is larger than ${timings.maxPackageBytes} bytes. Nothing was installed.`
            );
            return undefined;
        }
        let bytes = await file.read();
        let packageSha256 = await sha256Hex(verification.subtle, bytes);
        let verdict: ReleasePackageVerdict = await verifyReleasePackage(bytes, verification);
        for (const pause of timings.incompleteRetryDelaysMs) {
            // A package which was already rejected in this form is not waited for again.
            const mayBeIncomplete = verdict.status === "rejected" && verdict.code === INCOMPLETE_CODE;
            if (!mayBeIncomplete || records.hasNoticed(packageSha256)) break;
            await this.ports.wait(pause);
            if (this.ports.hasUnloaded()) return undefined;
            bytes = await file.read();
            packageSha256 = await sha256Hex(verification.subtle, bytes);
            verdict = await verifyReleasePackage(bytes, verification);
        }
        if (verdict.status === "rejected") {
            this.noticeOnce(
                packageSha256,
                `Release package ${file.path} was rejected (${verdict.code}). Nothing was installed.`
            );
            return undefined;
        }
        if (verdict.status === "not-newer") {
            this.ports.log(
                `Release package ${file.path} holds release ${verdict.releaseNumber}, which is not newer than the running release ${verification.runningReleaseNumber}.`
            );
            return undefined;
        }
        if (records.hasFailedToLoad(packageSha256)) {
            this.ports.log(`Release package ${file.path} did not load on this device before and is not tried again.`);
            return undefined;
        }
        return { path: file.path, packageSha256, verified: verdict.package };
    }

    private async install(candidate: Candidate): Promise<ReleaseInstallOutcome | undefined> {
        const { install: env } = this.ports;
        const { releaseName } = candidate.verified;
        if (!env) {
            const message = `Release ${releaseName} from the vault was not installed: this version of the app cannot unload and load a plug-in, so the new build could not be reloaded and checked.`;
            this.ports.log(message);
            if (!this.reloadUnavailableNoticed) this.ports.notify(message, true);
            this.reloadUnavailableNoticed = true;
            return undefined;
        }
        if (this.notStagedThisSession.has(candidate.packageSha256)) return undefined;
        const preparation = await prepareReleaseInstall(env, candidate.verified, candidate.packageSha256);
        if (preparation.status === "failed") {
            this.notStagedThisSession.add(candidate.packageSha256);
            const message = `Release ${releaseName} from the vault was not installed: ${preparation.reason}. Nothing was changed. It is tried again at the next start.`;
            this.ports.log(message);
            this.ports.notify(message, true);
            return undefined;
        }
        this.ports.log(`Release ${releaseName} is staged and is installed once nothing is being synchronised.`);
        this.installPending = true;
        return await this.completeWhenIdle(env, preparation.install);
    }

    /**
     * Wait, without limit, until the plug-in is idle at two looks in a row with no storage event in between, and
     * hand over to the installation at once: nothing is awaited between the last look and the unload.
     */
    private async completeWhenIdle(
        env: ReleaseInstallEnvironment,
        install: PreparedReleaseInstall
    ): Promise<ReleaseInstallOutcome | undefined> {
        let eventsAtLastIdleLook: number | undefined;
        for (;;) {
            // Unloaded by someone else: this instance changes nothing any more, and the next start begins again.
            if (this.ports.hasUnloaded()) return undefined;
            const events = this.ports.storageEventCount();
            const idle = isIdleForInstall(this.ports.currentActivity());
            if (idle && events === eventsAtLastIdleLook) return completeReleaseInstall(env, install);
            eventsAtLastIdleLook = idle ? events : undefined;
            await this.ports.wait(this.ports.timings.idlePollMs);
        }
    }
}
