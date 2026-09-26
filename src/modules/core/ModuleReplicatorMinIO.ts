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
            return Promise.resolve(new LiveSyncJournalReplicator(this.core));
        }
        return Promise.resolve(false);
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

    override onBindFunction(core: LiveSyncCore, services: typeof core.services): void {
        services.replicator.getNewReplicator.addHandler(this._anyNewReplicator.bind(this));
        services.appLifecycle.onResumed.addHandler(this._everyAfterResumeProcess.bind(this));
    }
}
