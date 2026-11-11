import { fireAndForget } from "octagonal-wheels/promises";
import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    REMOTE_MINIO,
    type ObsidianLiveSyncSettings,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    EVENT_LAYOUT_READY,
    EVENT_PLUGIN_LOADED,
    EVENT_REQUEST_RELOAD_SETTING_TAB,
    EVENT_SETTING_SAVED,
    eventHub,
} from "@/common/events.ts";
import { $msg, setLang } from "@/common/translation";
import { AbstractModule } from "@/modules/AbstractModule.ts";
import type { InjectableServiceHub } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableServiceHub";
import type { LiveSyncCore } from "@/main.ts";
import { initialiseWorkerModule } from "@vrtmrz/livesync-commonlib/compat/worker/bgWorker";
import { manifestVersion, packageVersion } from "@vrtmrz/livesync-commonlib/compat/common/coreEnvVars";
import type { VaultScanOutcome } from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import { compatGlobal, type CompatTimeoutHandle } from "@vrtmrz/livesync-commonlib/compat/common/coreEnvFunctions";

function isIndexedDbReadFailure(error: unknown): boolean {
    const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return description.toLowerCase().includes("indexed_db_went_bad");
}

export class ModuleLiveSyncMain extends AbstractModule {
    private deferredScan = false;
    private deferredScanComplete = false;
    private deferredScanRun?: Promise<void>;
    private deferredStartup?: CompatTimeoutHandle;
    private initialReplicationStarted = false;
    private initialReplicationPending = false;
    private startupScanDeadline?: CompatTimeoutHandle;
    private deferredStopped = false;
    private readinessAttempts = 0;
    private resumeRequested = false;
    private postScanReplicationPending = false;
    private postScanReplicationRun?: Promise<void>;
    private postScanRetry?: CompatTimeoutHandle;
    private postScanRetryBudget = 1;

    private startDeferredMobileStartup(): void {
        if (!this.deferredScan || this.deferredStopped || this.services.appLifecycle.hasUnloaded()) return;
        if (this.services.appLifecycle.isSuspended()) return;
        if (!this.services.appLifecycle.isReady()) {
            if (!this.deferredStartup && this.readinessAttempts++ < 5) {
                this.deferredStartup = compatGlobal.setTimeout(() => {
                    this.deferredStartup = undefined;
                    this.startDeferredMobileStartup();
                }, 50);
            }
            return;
        }
        this.readinessAttempts = 0;
        if (!this.initialReplicationStarted && this.settings.syncOnStart) {
            this.initialReplicationStarted = true;
            this.initialReplicationPending = true;
            fireAndForget(async () => {
                try {
                    await this.services.replication.replicate();
                } finally {
                    this.initialReplicationPending = false;
                    if (this.startupScanDeadline) compatGlobal.clearTimeout(this.startupScanDeadline);
                    this.startupScanDeadline = undefined;
                    this.startDeferredMobileStartup();
                }
            });
        }
        if (this.initialReplicationPending) {
            // Incoming notes get the first storage operations; an unavailable remote cannot hold back offline work.
            if (!this.startupScanDeadline)
                this.startupScanDeadline = compatGlobal.setTimeout(() => {
                    this.startupScanDeadline = undefined;
                    this.startDeferredScan();
                }, 5_000);
            return;
        }
        this.startDeferredScan();
        void this.retryPostScanReplication();
    }

    private startDeferredScan(): void {
        if (!this.deferredScan || this.deferredStopped || this.deferredScanComplete || this.deferredScanRun) return;
        if (
            this.services.appLifecycle.hasUnloaded() ||
            this.services.appLifecycle.isSuspended() ||
            !this.services.appLifecycle.isReady()
        )
            return;
        this.deferredScanRun = this.runDeferredScan().finally(() => {
            this.deferredScanRun = undefined;
            if (this.resumeRequested) {
                this.resumeRequested = false;
                this.startDeferredMobileStartup();
            }
        });
    }

    private clearDeferredTimers(): void {
        if (this.deferredStartup) compatGlobal.clearTimeout(this.deferredStartup);
        if (this.postScanRetry) compatGlobal.clearTimeout(this.postScanRetry);
        if (this.startupScanDeadline) compatGlobal.clearTimeout(this.startupScanDeadline);
        this.deferredStartup = undefined;
        this.postScanRetry = undefined;
        this.startupScanDeadline = undefined;
    }

    private async retryPostScanReplication(): Promise<void> {
        if (!this.postScanReplicationPending || this.postScanReplicationRun || this.deferredStopped) return;
        if (this.services.appLifecycle.hasUnloaded() || this.services.appLifecycle.isSuspended()) return;
        if (this.postScanRetry) compatGlobal.clearTimeout(this.postScanRetry);
        this.postScanRetry = undefined;
        this.postScanReplicationRun = (async () => {
            try {
                const replicated = await this.services.replication.replicateByEvent();
                if (replicated !== false) this.postScanReplicationPending = false;
            } catch (error) {
                this._log("Synchronisation after reconciliation is waiting for a retry", LOG_LEVEL_INFO);
                this._log(error, LOG_LEVEL_VERBOSE);
            } finally {
                if (
                    this.postScanReplicationPending &&
                    this.postScanRetryBudget > 0 &&
                    !this.deferredStopped &&
                    !this.services.appLifecycle.hasUnloaded() &&
                    !this.services.appLifecycle.isSuspended()
                ) {
                    this.postScanRetryBudget--;
                    this.postScanRetry = compatGlobal.setTimeout(() => {
                        this.postScanRetry = undefined;
                        void this.retryPostScanReplication();
                    }, 1_000);
                }
            }
        })();
        try {
            await this.postScanReplicationRun;
        } finally {
            this.postScanReplicationRun = undefined;
        }
    }

    private async runDeferredScan(): Promise<void> {
        const outcome: VaultScanOutcome = {};
        const started = Date.now();
        try {
            const scanned = await this.services.vault.scanVault(false, false, outcome);
            if (this.deferredStopped || this.services.appLifecycle.hasUnloaded()) return;
            this._log(`Continued full reconciliation: ${Date.now() - started} ms`, LOG_LEVEL_INFO);
            if (outcome.interrupted) {
                return;
            }
            const failures = outcome.failedPairs ?? 0;
            const queued = (outcome.queuedForReflection ?? 0) + (outcome.queuedAsStorageEvents ?? 0);
            if (scanned || (failures > 0 && queued >= failures)) {
                this.logFilesTriedAgain(outcome);
                this.deferredScanComplete = true;
                this.postScanReplicationPending = true;
                await this.retryPostScanReplication();
                return;
            }
            if (this.services.appLifecycle.isSuspended()) return;
            if (!scanned && outcome.failedPairs === undefined) {
                // A failed scan without an aggregate result is a global safety failure.
                this.services.appLifecycle.resetIsReady();
                this.services.appLifecycle.setSuspended(true);
                this._log("Full reconciliation could not be verified; synchronisation has stopped", LOG_LEVEL_NOTICE);
                return;
            }
            this.logFilesTriedAgain(outcome);
        } catch (error) {
            if (this.deferredStopped || this.services.appLifecycle.hasUnloaded()) return;
            this.services.appLifecycle.resetIsReady();
            this.services.appLifecycle.setSuspended(true);
            this._log(
                "A database error interrupted full reconciliation; synchronisation has stopped",
                LOG_LEVEL_NOTICE
            );
            this._log(error, LOG_LEVEL_VERBOSE);
        }
    }
    /**
     * State which files the start-up scan could not process, and how and when each is tried again.
     *
     * Start-up continues regardless: a file whose chunks have not arrived yet, for example after a receive was
     * interrupted, cannot be written, and the synchronisation which brings them starts only once start-up has completed.
     */
    private logFilesTriedAgain(outcome: VaultScanOutcome) {
        const failed = outcome.failedPairs ?? 0;
        if (failed === 0) return;
        const written = outcome.queuedForReflection ?? 0;
        const stored = outcome.queuedAsStorageEvents ?? 0;
        const nextScan = failed - written - stored;
        const retries = [
            written > 0
                ? `${written} to be written from the database by the queue of received changes, which tries one whose chunks have not arrived again before each synchronisation, also after a restart`
                : "",
            stored > 0 ? `${stored} to be stored into the database from the storage events queued again` : "",
            nextScan > 0 ? `${nextScan} at the next full scan` : "",
        ].filter((retry) => retry !== "");
        this._log(
            `The start-up scan could not process ${failed} file(s), and start-up continues. They are tried again: ${retries.join("; ")}.`,
            LOG_LEVEL_INFO
        );
    }

    async _onLiveSyncReady() {
        if (!(await this.core.services.appLifecycle.onLayoutReady())) return false;
        eventHub.emitEvent(EVENT_LAYOUT_READY);
        if (this.settings.suspendFileWatching || this.settings.suspendParseReplicationResult) {
            const ANSWER_KEEP = $msg("moduleLiveSyncMain.optionKeepLiveSyncDisabled");
            const ANSWER_RESUME = $msg("moduleLiveSyncMain.optionResumeAndRestart");
            const message = $msg("moduleLiveSyncMain.msgScramEnabled", {
                fileWatchingStatus: this.settings.suspendFileWatching ? "suspended" : "active",
                parseReplicationStatus: this.settings.suspendParseReplicationResult ? "suspended" : "active",
            });
            if (
                (await this.core.confirm.askSelectStringDialogue(message, [ANSWER_KEEP, ANSWER_RESUME], {
                    defaultAction: ANSWER_KEEP,
                    title: $msg("moduleLiveSyncMain.titleScramEnabled"),
                })) == ANSWER_RESUME
            ) {
                this.settings.suspendFileWatching = false;
                this.settings.suspendParseReplicationResult = false;
                await this.saveSettings();
                this.services.appLifecycle.scheduleRestart();
                return false;
            }
        }
        // The host may have been unloaded while the layout was becoming ready, for example by a release install
        // during start-up. Opening and scanning the database then does nothing useful; the next start begins again.
        if (this.core.services.appLifecycle.hasUnloaded()) return false;
        // Start-up continues when only individual files of the scan failed; the preparation then completes itself.
        const scanOutcome: VaultScanOutcome = {};
        const deferFullScan =
            this.services.API.isMobile?.() === true &&
            this.settings.remoteType === REMOTE_MINIO &&
            typeof this.services.vault.prepareForEarlyReplication === "function";
        let isInitialized: boolean;
        try {
            isInitialized = await this.services.databaseEvents.initialiseDatabase(false, false, false, {
                completeAfterFailedPairs: true,
                scanOutcome,
                ...(deferFullScan ? { deferFullScan: true } : {}),
            });
        } catch (error) {
            if (!isIndexedDbReadFailure(error)) throw error;
            this._log(
                "The browser reported 'indexed_db_went_bad' while reading the local database. LiveSync stopped before replication to protect local and remote data. Back up this Vault, then follow 'Local IndexedDB cannot be read' in the troubleshooting guide. Do not use Rebuild unless this device's Vault has been verified as the authoritative copy.",
                LOG_LEVEL_NOTICE
            );
            this._log(error, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (!isInitialized) {
            //TODO:stop all sync.
            return false;
        }
        this.logFilesTriedAgain(scanOutcome);
        if (!(await this.core.services.appLifecycle.onFirstInitialise())) return false;
        // await this.core.$$realizeSettingSyncMode();
        await this.services.control.applySettings();
        if (this.deferredStopped || this.services.appLifecycle.hasUnloaded()) return false;
        this.deferredScan = deferFullScan;
        if (deferFullScan) {
            // The settings lifecycle can finish its resume callback before the outer ready callback has settled.
            // Start both operations on the next task, and call replication before the background enumeration.
            this.deferredStartup = compatGlobal.setTimeout(() => {
                this.deferredStartup = undefined;
                this.startDeferredMobileStartup();
            }, 0);
        }
        fireAndForget(async () => {
            this._log($msg("moduleLiveSyncMain.logAdditionalSafetyScan"), LOG_LEVEL_VERBOSE);
            if (!(await this.services.appLifecycle.onScanningStartupIssues())) {
                this._log($msg("moduleLiveSyncMain.logSafetyScanFailed"), LOG_LEVEL_NOTICE);
            } else {
                this._log($msg("moduleLiveSyncMain.logSafetyScanCompleted"), LOG_LEVEL_VERBOSE);
            }
        });
        return true;
    }

    _wireUpEvents() {
        eventHub.onEvent(EVENT_SETTING_SAVED, (settings: ObsidianLiveSyncSettings) => {
            fireAndForget(async () => {
                try {
                    const lang = this.core.services.setting.currentSettings()?.displayLanguage;
                    if (lang !== undefined) {
                        setLang(lang);
                    }
                    if (this.core.services.database.isDatabaseReady()) {
                        await this.core.services.control.applySettings();
                    }
                    eventHub.emitEvent(EVENT_REQUEST_RELOAD_SETTING_TAB);
                } catch (e) {
                    this._log(`Error in Setting Save Event`, LOG_LEVEL_NOTICE);
                    this._log(e, LOG_LEVEL_VERBOSE);
                }
            });
        });
        return Promise.resolve(true);
    }

    async _onLiveSyncLoad(): Promise<boolean> {
        initialiseWorkerModule(this.services.context.events);
        await this.services.appLifecycle.onWireUpEvents();
        // debugger;
        eventHub.emitEvent(EVENT_PLUGIN_LOADED);
        this._log($msg("moduleLiveSyncMain.logLoadingPlugin"));
        if (!(await this.services.appLifecycle.onInitialise())) {
            this._log($msg("moduleLiveSyncMain.logPluginInitCancelled"), LOG_LEVEL_NOTICE);
            return false;
        }
        // this.addUIs();
        this._log($msg("moduleLiveSyncMain.logPluginVersion", { manifestVersion, packageVersion }));
        await this.services.setting.loadSettings();
        if (!(await this.services.appLifecycle.onSettingLoaded())) {
            this._log($msg("moduleLiveSyncMain.logPluginInitCancelled"), LOG_LEVEL_NOTICE);
            return false;
        }
        // Do not open the database for a host which has been unloaded in the meantime.
        if (this.core.services.appLifecycle.hasUnloaded()) return false;
        await this.services.database.openDatabase({
            databaseEvents: this.services.databaseEvents,
            replicator: this.services.replicator,
        });
        // this.core.$$realizeSettingSyncMode = this.core.$$realizeSettingSyncMode.bind(this);
        // this.$$parseReplicationResult = this.$$parseReplicationResult.bind(this);
        // this.$$replicate = this.$$replicate.bind(this);
        // this.core.$$onLiveSyncReady = this.core.$$onLiveSyncReady.bind(this);
        await this.core.services.appLifecycle.onLoaded();
        await Promise.all(this.core.addOns.map((e) => Promise.resolve(e.onload())));
        return true;
    }

    // async _onLiveSyncUnload(): Promise<void> {
    //     eventHub.emitEvent(EVENT_PLUGIN_UNLOADED);
    //     await this.services.appLifecycle.onBeforeUnload();
    //     cancelAllPeriodicTask();
    //     cancelAllTasks();
    //     stopAllRunningProcessors();
    //     await this.services.appLifecycle.onUnload();
    //     this._unloaded = true;
    //     for (const addOn of this.core.addOns) {
    //         addOn.onunload();
    //     }
    //     if (this.localDatabase != null) {
    //         this.localDatabase.onunload();
    //         if (this.core.replicator) {
    //             this.core.replicator?.closeReplication();
    //         }
    //         await this.localDatabase.close();
    //     }
    //     eventHub.emitEvent(EVENT_PLATFORM_UNLOADED);
    //     eventHub.offAll();
    //     this._log($msg("moduleLiveSyncMain.logUnloadingPlugin"));
    //     return;
    // }

    // private async _realizeSettingSyncMode(): Promise<void> {
    //     await this.services.appLifecycle.onSuspending();
    //     await this.services.setting.onBeforeRealiseSetting();
    //     this.localDatabase.refreshSettings();
    //     await this.services.fileProcessing.commitPendingFileEvents();
    //     await this.services.setting.onRealiseSetting();
    //     // disable all sync temporary.
    //     if (this.services.appLifecycle.isSuspended()) return;
    //     await this.services.appLifecycle.onResuming();
    //     await this.services.appLifecycle.onResumed();
    //     await this.services.setting.onSettingRealised();
    //     return;
    // }

    // isReady = false;

    // _isReady(): boolean {
    //     return this.isReady;
    // }

    // _markIsReady(): void {
    //     this.isReady = true;
    // }

    // _resetIsReady(): void {
    //     this.isReady = false;
    // }

    // _suspended = false;
    // _isSuspended(): boolean {
    //     return this._suspended || !this.settings?.isConfigured;
    // }

    // _setSuspended(value: boolean) {
    //     this._suspended = value;
    // }

    // _unloaded = false;
    // _isUnloaded(): boolean {
    //     return this._unloaded;
    // }

    override onBindFunction(core: LiveSyncCore, services: InjectableServiceHub): void {
        super.onBindFunction(core, services);
        // services.appLifecycle.isSuspended.setHandler(this._isSuspended.bind(this));
        // services.appLifecycle.setSuspended.setHandler(this._setSuspended.bind(this));
        // services.appLifecycle.isReady.setHandler(this._isReady.bind(this));
        // services.appLifecycle.markIsReady.setHandler(this._markIsReady.bind(this));
        // services.appLifecycle.resetIsReady.setHandler(this._resetIsReady.bind(this));
        // services.appLifecycle.hasUnloaded.setHandler(this._isUnloaded.bind(this));
        services.appLifecycle.onReady.addHandler(this._onLiveSyncReady.bind(this));
        services.appLifecycle.onWireUpEvents.addHandler(this._wireUpEvents.bind(this));
        services.appLifecycle.onLoad.addHandler(this._onLiveSyncLoad.bind(this));
        services.appLifecycle.onResumed.addHandler(() => {
            this.readinessAttempts = 0;
            this.postScanRetryBudget = 1;
            if (this.deferredScanRun) this.resumeRequested = true;
            this.startDeferredMobileStartup();
            return Promise.resolve(true);
        });
        services.appLifecycle.onSuspending.addHandler(() => {
            this.clearDeferredTimers();
            return Promise.resolve(true);
        });
        services.appLifecycle.onBeforeUnload.addHandler(() => {
            this.deferredStopped = true;
            this.resumeRequested = false;
            this.clearDeferredTimers();
            return Promise.resolve(true);
        });
    }
}
