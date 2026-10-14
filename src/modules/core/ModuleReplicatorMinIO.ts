import { fireAndForget } from "octagonal-wheels/promises";
import { REMOTE_MINIO, type RemoteDBSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { LiveSyncJournalReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/journal/LiveSyncJournalReplicator";
import type { LiveSyncAbstractReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/LiveSyncAbstractReplicator";
import type { LiveSyncCore } from "@/main";
import { AbstractModule } from "@/modules/AbstractModule";

export class ModuleReplicatorMinIO extends AbstractModule {
    /** Whether the application has resumed since it was loaded, which the start-up does first. */
    private resumedOnce = false;

    _anyNewReplicator(settingOverride: Partial<RemoteDBSettings> = {}): Promise<LiveSyncAbstractReplicator | false> {
        const settings = { ...this.settings, ...settingOverride };
        if (settings.remoteType == REMOTE_MINIO) {
            const replicator = new LiveSyncJournalReplicator(this.core);
            // Every synchronisation asks, also the one which sends what was written when the application is hidden.
            replicator.mayReceiveDeferredContent = () => this.mayReceiveDeferredContent();
            return Promise.resolve(replicator);
        }
        return Promise.resolve(false);
    }

    /**
     * Whether large content which the replicator puts off may be fetched now.
     *
     * Not while a mobile application is hidden: the system may stop it at any time, and what it was started for
     * then, sending what was written, must not wait for large content.
     */
    private mayReceiveDeferredContent(): boolean {
        return !(this.services.API.isMobile() && isApplicationHidden());
    }

    /**
     * Synchronise at once when the application starts or returns to the foreground, instead of an interval later.
     *
     * Applying saved settings suspends and resumes the application as well; that does not synchronise, apart from the
     * first resume, which is the one of the start-up. A synchronisation which fails leaves its work pending, and the
     * periodic replication tries again.
     */
    _everyAfterResumeProcess(): Promise<boolean> {
        if (!this.services.appLifecycle.isReady()) return Promise.resolve(true);
        const atStartUp = !this.resumedOnce;
        this.resumedOnce = true;
        if (!atStartUp && this.services.control.isApplyingSettings()) return Promise.resolve(true);
        if (this.services.appLifecycle.isSuspended()) return Promise.resolve(true);
        if (this.settings.remoteType != REMOTE_MINIO || !this.settings.syncOnStart) return Promise.resolve(true);
        fireAndForget(() => this.services.replication.replicate());
        return Promise.resolve(true);
    }

    /**
     * Synchronise again at once after a synchronisation which received content the replicator had put off.
     *
     * Large chunks are fetched last and only for a while in each synchronisation. Documents which waited for them
     * are tried again before the next one, and more chunks may remain, so that one starts now instead of an interval
     * later. A hidden mobile application starts none: it may be stopped at any time, and synchronises when it
     * returns.
     */
    _continueAfterDeferredReceive(): void {
        if (this.services.replicator.finiteReplicationActivityCount.value !== 0) return;
        if (this.settings.remoteType != REMOTE_MINIO) return;
        if (!this.services.appLifecycle.isReady() || this.services.appLifecycle.isSuspended()) return;
        if (!this.mayReceiveDeferredContent()) return;
        // An answer which is left untaken here is cleared by the next synchronisation, so it cannot start one late.
        // The replicator is looked for without reporting that none is active, as nothing is replicated yet.
        if (!this.services.replicator.peekActiveReplicator()?.takeDeferredReceiveContinuation()) return;
        fireAndForget(() => this.services.replication.replicate());
    }

    override onBindFunction(core: LiveSyncCore, services: typeof core.services): void {
        services.replicator.getNewReplicator.addHandler(this._anyNewReplicator.bind(this));
        services.appLifecycle.onResumed.addHandler(this._everyAfterResumeProcess.bind(this));
        services.replicator.finiteReplicationActivityCount.onChanged(() => this._continueAfterDeferredReceive());
    }
}

/** Whether the window of the application is hidden. A host without such a window is never hidden. */
function isApplicationHidden(): boolean {
    return typeof activeWindow !== "undefined" && activeWindow.document.hidden;
}
