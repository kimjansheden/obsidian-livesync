import { describe, it, expect, vi, afterEach } from "vitest";

import { ModuleObsidianEvents } from "./ModuleObsidianEvents";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB, REMOTE_MINIO } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { ObsidianReplicationService, ObsidianReplicatorService } from "@/modules/services/ObsidianServices";

type SetupOptions = {
    settings?: Partial<typeof DEFAULT_SETTINGS>;
    hidden: boolean;
    isLastHidden?: boolean;
    hasFocus?: boolean;
    isSuspended?: boolean;
    // Platform is read via services.API.isMobile(); default desktop (false) so the feature applies.
    isMobile?: boolean;
    abortedStaleRequests?: number;
    /** Whether the active replicator reports local changes which have not been sent. */
    unsentLocalChanges?: boolean;
};

function setup(opts: SetupOptions) {
    const appLifecycle = {
        isReady: vi.fn(() => true),
        isSuspended: vi.fn(() => opts.isSuspended ?? false),
        onSuspending: vi.fn(async () => true),
        onResuming: vi.fn(async () => true),
        onResumed: vi.fn(async () => true),
    };
    const fileProcessing = {
        commitPendingFileEvents: vi.fn(async () => true),
        totalQueued: reactiveSource(0),
        totalStorageFileEventCount: 0,
    };
    const boundedRemoteActivityCount = reactiveSource(0);
    const boundedLocalApplicationActivityCount = reactiveSource(0);
    const finiteReplicationActivityCount = reactiveSource(0);
    const abortStaleRemoteRequests = vi.fn((_startedBefore: number) => opts.abortedStaleRequests ?? 0);
    const hasUnsentLocalChanges = vi.fn(async () => opts.unsentLocalChanges ?? false);
    const replicate = vi.fn(async () => true);
    const storeFileToDBUnderFileEventLock = vi.fn(async (_path: string) => true);
    // Counted before the task is awaited, as the replicator service does.
    const runFiniteReplicationActivity = vi.fn(async (task: () => Promise<unknown>) => {
        boundedRemoteActivityCount.value++;
        finiteReplicationActivityCount.value++;
        try {
            return await task();
        } finally {
            finiteReplicationActivityCount.value--;
            boundedRemoteActivityCount.value--;
        }
    });
    const runBoundedLocalApplicationActivity = vi.fn(async (task: () => Promise<unknown>) => {
        boundedLocalApplicationActivityCount.value++;
        try {
            return await task();
        } finally {
            boundedLocalApplicationActivityCount.value--;
        }
    });
    const editor = { file: { path: "note.md" }, save: vi.fn(async () => undefined) };
    const workspace = { getLeavesOfType: vi.fn((_type: string) => [{ view: editor }, { view: {} }]) };

    const core = {
        _services: {
            API: {
                addLog: vi.fn(),
                addCommand: vi.fn(),
                registerWindow: vi.fn(),
                addRibbonIcon: vi.fn(),
                registerProtocolHandler: vi.fn(),
                isMobile: vi.fn(() => opts.isMobile ?? false),
            },
            setting: { saveSettingData: vi.fn(async () => undefined) },
            appLifecycle,
            fileProcessing,
            replicator: {
                boundedRemoteActivityCount,
                boundedLocalApplicationActivityCount,
                finiteReplicationActivityCount,
                getActiveReplicator: () => ({ abortStaleRemoteRequests, hasUnsentLocalChanges }),
                runBoundedLocalApplicationActivity,
                runFiniteReplicationActivity,
            },
            replication: { replicate },
        },
        settings: {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_COUCHDB,
            isConfigured: true,
            ...opts.settings,
        },
        serviceModules: { fileHandler: { storeFileToDBUnderFileEventLock } },
    } as any;
    Object.defineProperty(core, "services", { get: () => core._services });

    const module = new ModuleObsidianEvents({ app: { workspace } } as any, core);
    module.isLastHidden = opts.isLastHidden ?? false;
    module.hasFocus = opts.hasFocus ?? true;

    // The handler reads `activeWindow.document.hidden`.
    (globalThis as any).activeWindow = { document: { hidden: opts.hidden } };

    return {
        module,
        appLifecycle,
        fileProcessing,
        boundedRemoteActivityCount,
        boundedLocalApplicationActivityCount,
        finiteReplicationActivityCount,
        runBoundedLocalApplicationActivity,
        runFiniteReplicationActivity,
        abortStaleRemoteRequests,
        hasUnsentLocalChanges,
        replicate,
        storeFileToDBUnderFileEventLock,
        editor,
        workspace,
        core,
    };
}

describe("watchWindowVisibilityAsync — keepReplicationActiveInBackground", () => {
    afterEach(() => {
        // The handler reads a global `activeWindow`; clear it so it doesn't leak into sibling spec
        // files running in the same worker.
        delete (globalThis as any).activeWindow;
    });

    it("does NOT suspend on hide when enabled in LiveSync mode on the desktop app", async () => {
        const { module, appLifecycle } = setup({
            settings: { keepReplicationActiveInBackground: true, liveSync: true },
            hidden: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
    });

    it("suspends on hide by default (setting off)", async () => {
        const { module, appLifecycle } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: true },
            hidden: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);
    });

    it("defers desktop suspension while bounded remote activity is running", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: false },
            hidden: true,
        });
        boundedRemoteActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
    });

    it("suspends a hidden desktop window after the final bounded remote activity ends", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: false },
            hidden: true,
        });
        boundedRemoteActivityCount.value = 1;
        await module.watchWindowVisibilityAsync();

        boundedRemoteActivityCount.value = 0;

        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1));
    });

    it("defers suspension while local document application is active", async () => {
        const { module, appLifecycle, boundedLocalApplicationActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: false },
            hidden: true,
        });
        boundedLocalApplicationActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();

        boundedLocalApplicationActivityCount.value = 0;
        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1));
    });

    it("defers mobile suspension while bounded remote activity is running", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: false },
            hidden: true,
            isMobile: true,
        });
        boundedRemoteActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();

        boundedRemoteActivityCount.value = 0;

        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1));
    });

    it("records deferred suspension while rebuild file watching is suspended", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount, fileProcessing } = setup({
            settings: { suspendFileWatching: true },
            hidden: true,
        });
        boundedRemoteActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();

        boundedRemoteActivityCount.value = 0;

        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1));
    });

    it("resumes after a hidden rebuild finishes and the window becomes visible", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { suspendFileWatching: true },
            hidden: true,
        });
        boundedRemoteActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();
        boundedRemoteActivityCount.value = 0;
        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1));

        (module.settings as typeof DEFAULT_SETTINGS).suspendFileWatching = false;
        (globalThis as any).activeWindow.document.hidden = false;
        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onResuming).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1);
    });

    it("does not resume when the window becomes visible before deferred suspension runs", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: false },
            hidden: true,
        });
        boundedRemoteActivityCount.value = 1;
        await module.watchWindowVisibilityAsync();

        (globalThis as any).activeWindow.document.hidden = false;
        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(appLifecycle.onResuming).not.toHaveBeenCalled();
        expect(appLifecycle.onResumed).not.toHaveBeenCalled();

        boundedRemoteActivityCount.value = 0;
        await Promise.resolve();
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(appLifecycle.onResuming).not.toHaveBeenCalled();
        expect(appLifecycle.onResumed).not.toHaveBeenCalled();
    });

    it("forces onSuspending before the resume on becoming visible when enabled (LiveSync teardown)", async () => {
        const { module, appLifecycle } = setup({
            settings: { keepReplicationActiveInBackground: true, liveSync: true },
            hidden: false,
            isLastHidden: true, // hidden -> visible transition
        });
        await module.watchWindowVisibilityAsync();
        // Decision-logic only: on visible + enabled + LiveSync the handler calls onSuspending (the
        // forced teardown) before onResuming. The actual stalled-channel replacement is exercised by
        // the manual integration test, not here.
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onResuming).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onSuspending.mock.invocationCallOrder[0]).toBeLessThan(
            appLifecycle.onResuming.mock.invocationCallOrder[0]
        );
    });

    it("defers the LiveSync teardown on becoming visible until bounded remote activity ends", async () => {
        const { module, appLifecycle, boundedRemoteActivityCount } = setup({
            settings: { keepReplicationActiveInBackground: true, liveSync: true },
            hidden: false,
            isLastHidden: true,
        });
        boundedRemoteActivityCount.value = 1;

        await module.watchWindowVisibilityAsync();

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(appLifecycle.onResuming).not.toHaveBeenCalled();
        expect(appLifecycle.onResumed).not.toHaveBeenCalled();

        boundedRemoteActivityCount.value = 0;

        await vi.waitFor(() => expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1));
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onResuming).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onSuspending.mock.invocationCallOrder[0]).toBeLessThan(
            appLifecycle.onResuming.mock.invocationCallOrder[0]
        );
    });

    it("does not force a teardown on becoming visible by default (setting off)", async () => {
        const { module, appLifecycle } = setup({
            settings: { keepReplicationActiveInBackground: false, liveSync: true },
            hidden: false,
            isLastHidden: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1);
    });

    it("does not apply in On-Events mode even if the flag is set (no scope leak)", async () => {
        const { module, appLifecycle } = setup({
            settings: {
                keepReplicationActiveInBackground: true,
                liveSync: false,
                periodicReplication: false,
            },
            hidden: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);
    });

    it("does NOT suspend on hide when enabled in Periodic mode (the periodic timer also stalls otherwise)", async () => {
        const { module, appLifecycle } = setup({
            settings: {
                keepReplicationActiveInBackground: true,
                liveSync: false,
                periodicReplication: true,
            },
            hidden: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
    });

    it("does NOT force a teardown on becoming visible in Periodic mode (only the continuous channel can stall)", async () => {
        const { module, appLifecycle } = setup({
            settings: {
                keepReplicationActiveInBackground: true,
                liveSync: false,
                periodicReplication: true,
            },
            hidden: false,
            isLastHidden: true,
        });
        await module.watchWindowVisibilityAsync();
        // The teardown is gated on liveSync: a periodic timer doesn't go half-open, so bouncing it
        // on every restore would be needless churn. Resume still runs normally.
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(appLifecycle.onResuming).toHaveBeenCalledTimes(1);
        expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1);
    });

    it("does not apply on mobile even if the flag is set", async () => {
        const { module, appLifecycle } = setup({
            settings: { keepReplicationActiveInBackground: true, liveSync: true },
            hidden: true,
            isMobile: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);
    });
});

describe("watchWindowVisibilityAsync — remote requests left waiting from the background", () => {
    const periodicSettings = { keepReplicationActiveInBackground: false, liveSync: false, periodicReplication: true };

    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as any).activeWindow;
    });

    async function returnWhileRemoteActivityIsRunning(opts: {
        isMobile: boolean;
        abortedStaleRequests?: number;
        replicationCycle?: boolean;
    }) {
        vi.useFakeTimers();
        const { replicationCycle = true, ...setupOptions } = opts;
        const context = setup({ settings: periodicSettings, hidden: true, ...setupOptions });
        context.boundedRemoteActivityCount.value = 1;
        context.finiteReplicationActivityCount.value = replicationCycle ? 1 : 0;
        await context.module.watchWindowVisibilityAsync();

        (globalThis as any).activeWindow.document.hidden = false;
        const visibleAt = Date.now();
        await context.module.watchWindowVisibilityAsync();
        return { ...context, visibleAt };
    }

    it("aborts requests still waiting after the grace period and runs the pending replication again", async () => {
        const { abortStaleRemoteRequests, replicate, boundedRemoteActivityCount, visibleAt } =
            await returnWhileRemoteActivityIsRunning({ isMobile: true, abortedStaleRequests: 1 });

        await vi.advanceTimersByTimeAsync(9_999);
        expect(abortStaleRemoteRequests).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(abortStaleRemoteRequests).toHaveBeenCalledExactlyOnceWith(visibleAt);
        expect(replicate).not.toHaveBeenCalled();

        boundedRemoteActivityCount.value = 0;
        await vi.waitFor(() => expect(replicate).toHaveBeenCalledTimes(1));
    });

    it("does not abort a rebuild or other remote work which is not a replication cycle", async () => {
        const { abortStaleRemoteRequests, replicate } = await returnWhileRemoteActivityIsRunning({
            isMobile: true,
            abortedStaleRequests: 1,
            replicationCycle: false,
        });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(abortStaleRemoteRequests).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
    });

    it("does not run the replication again when the app is hidden before the aborted cycle unwinds", async () => {
        const { module, abortStaleRemoteRequests, replicate, boundedRemoteActivityCount } =
            await returnWhileRemoteActivityIsRunning({ isMobile: true, abortedStaleRequests: 1 });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortStaleRemoteRequests).toHaveBeenCalledTimes(1);

        (globalThis as any).activeWindow.document.hidden = true;
        await module.watchWindowVisibilityAsync();
        boundedRemoteActivityCount.value = 0;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(replicate).not.toHaveBeenCalled();
    });

    it("stops waiting for an aborted cycle which does not unwind", async () => {
        const { abortStaleRemoteRequests, replicate, boundedRemoteActivityCount } =
            await returnWhileRemoteActivityIsRunning({ isMobile: true, abortedStaleRequests: 1 });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortStaleRemoteRequests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60_000);
        boundedRemoteActivityCount.value = 0;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(replicate).not.toHaveBeenCalled();
    });

    it("leaves a request which settles during the grace period alone", async () => {
        const { abortStaleRemoteRequests, replicate, boundedRemoteActivityCount } =
            await returnWhileRemoteActivityIsRunning({ isMobile: true, abortedStaleRequests: 1 });

        boundedRemoteActivityCount.value = 0;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(abortStaleRemoteRequests).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
    });

    it("does not start another replication when nothing was aborted", async () => {
        const { abortStaleRemoteRequests, replicate, boundedRemoteActivityCount } =
            await returnWhileRemoteActivityIsRunning({ isMobile: true, abortedStaleRequests: 0 });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortStaleRemoteRequests).toHaveBeenCalledTimes(1);

        boundedRemoteActivityCount.value = 0;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(replicate).not.toHaveBeenCalled();
    });

    it("does not abort when the app is hidden again before the grace period ends", async () => {
        const { module, abortStaleRemoteRequests } = await returnWhileRemoteActivityIsRunning({
            isMobile: true,
            abortedStaleRequests: 1,
        });

        (globalThis as any).activeWindow.document.hidden = true;
        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(abortStaleRemoteRequests).not.toHaveBeenCalled();
    });

    it("does not abort requests on the desktop app", async () => {
        const { abortStaleRemoteRequests, replicate } = await returnWhileRemoteActivityIsRunning({
            isMobile: false,
            abortedStaleRequests: 1,
        });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(abortStaleRemoteRequests).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
    });

    it("also checks after a regular resume, using the time the app became visible", async () => {
        vi.useFakeTimers();
        const {
            module,
            appLifecycle,
            abortStaleRemoteRequests,
            boundedRemoteActivityCount,
            finiteReplicationActivityCount,
        } = setup({
            settings: periodicSettings,
            hidden: true,
            isMobile: true,
        });
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onSuspending).toHaveBeenCalledTimes(1);

        (globalThis as any).activeWindow.document.hidden = false;
        const visibleAt = Date.now();
        await module.watchWindowVisibilityAsync();
        expect(appLifecycle.onResumed).toHaveBeenCalledTimes(1);

        boundedRemoteActivityCount.value = 1;
        finiteReplicationActivityCount.value = 1;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(abortStaleRemoteRequests).toHaveBeenCalledExactlyOnceWith(visibleAt);
    });
});

describe("watchWindowVisibilityAsync — sending what was written when the mobile app is hidden", () => {
    const objectStorage = { remoteType: REMOTE_MINIO };

    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as any).activeWindow;
    });

    function hideMobileApp(opts: Partial<SetupOptions> = {}) {
        vi.useFakeTimers();
        return setup({ settings: objectStorage, hidden: true, isMobile: true, ...opts });
    }

    it("saves the open editors before the pending storage events are committed", async () => {
        const { module, editor, workspace, fileProcessing } = hideMobileApp();

        await module.watchWindowVisibilityAsync();

        expect(workspace.getLeavesOfType).toHaveBeenCalledWith("markdown");
        expect(editor.save).toHaveBeenCalledOnce();
        expect(editor.save.mock.invocationCallOrder[0]).toBeLessThan(
            fileProcessing.commitPendingFileEvents.mock.invocationCallOrder[0]
        );
    });

    it("sends changes which have not been sent, and suspends only once they are sent", async () => {
        const { module, appLifecycle, replicate } = hideMobileApp({ unsentLocalChanges: true });
        let finishSending!: () => void;
        replicate.mockImplementationOnce(
            () => new Promise<boolean>((resolve) => (finishSending = () => resolve(true)))
        );

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(replicate).toHaveBeenCalledOnce();
        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();

        finishSending();
        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledOnce());
    });

    it("lets the real replication coordinator finish readiness before the finite delivery activity starts", async () => {
        const { module, core, appLifecycle, fileProcessing, storeFileToDBUnderFileEventLock } = setup({
            settings: objectStorage,
            hidden: true,
            isMobile: true,
        });
        const context = { events: { emitEvent: vi.fn() }, translate: (key: string) => key } as never;
        const getUnresolvedMessages = Object.assign(
            vi.fn(async () => []),
            { addHandler: vi.fn() }
        );
        Object.assign(appLifecycle, {
            getUnresolvedMessages,
            onLoaded: { addHandler: vi.fn() },
            onResumed: Object.assign(appLifecycle.onResumed, { addHandler: vi.fn() }),
        });
        const settings = { currentSettings: () => core.settings };
        const replicator = new ObsidianReplicatorService(context, {
            settingService: settings,
            appLifecycleService: appLifecycle,
            databaseEventService: {},
            registerLifecycleHandlers: false,
            isMobile: () => true,
        } as never);
        const openReplication = vi.fn(async () => {
            expect(replicator.finiteReplicationActivityCount.value).toBe(1);
            expect(replicator.boundedRemoteActivityCount.value).toBe(1);
            expect(replicator.boundedLocalApplicationActivityCount.value).toBe(1);
            return true;
        });
        vi.spyOn(replicator, "getActiveReplicator").mockReturnValue({
            hasUnsentLocalChanges: vi.fn(async () => true),
            openReplication,
        } as never);
        let queueState: unknown;
        const queueStore = {
            get: vi.fn(async () => structuredClone(queueState)),
            atomicUpdate: vi.fn(
                async (_key: string, update: (value: unknown) => { value: unknown; result: unknown }) => {
                    const changed = update(structuredClone(queueState));
                    queueState = structuredClone(changed.value);
                    return changed.result;
                }
            ),
        };
        const replication = new ObsidianReplicationService(context, {
            APIService: { isOnline: true, isMobile: () => true, addLog: vi.fn() },
            appLifecycleService: appLifecycle,
            settingService: settings,
            databaseService: {},
            fileProcessingService: fileProcessing,
            replicatorService: replicator,
            replicationQueueStore: queueStore,
        } as never);
        const readinessFiniteCounts: number[] = [];
        replication.onCheckReplicationReady.addHandler(async () => {
            readinessFiniteCounts.push(replicator.finiteReplicationActivityCount.value);
            return replicator.finiteReplicationActivityCount.value === 0;
        });
        core._services.replicator = replicator;
        core._services.replication = replication;

        await module.watchWindowVisibilityAsync();
        await vi.waitFor(() => expect(openReplication).toHaveBeenCalledOnce(), { timeout: 2_500 });

        expect(storeFileToDBUnderFileEventLock).toHaveBeenCalledWith("note.md");
        expect(readinessFiniteCounts).toEqual([0]);
        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledOnce());
        expect(replicator.boundedRemoteActivityCount.value).toBe(0);
        expect(replicator.finiteReplicationActivityCount.value).toBe(0);
        expect(replicator.boundedLocalApplicationActivityCount.value).toBe(0);
    });

    it("still checks a stale remote request after the app returns during the hidden send", async () => {
        const {
            module,
            replicate,
            boundedRemoteActivityCount,
            boundedLocalApplicationActivityCount,
            finiteReplicationActivityCount,
            abortStaleRemoteRequests,
        } = hideMobileApp({ unsentLocalChanges: true });
        let finishReplication!: () => void;
        replicate.mockImplementationOnce(async () => {
            boundedRemoteActivityCount.value++;
            finiteReplicationActivityCount.value++;
            try {
                await new Promise<void>((resolve) => (finishReplication = resolve));
                return true;
            } finally {
                finiteReplicationActivityCount.value--;
                boundedRemoteActivityCount.value--;
            }
        });

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(300);
        expect(replicate).toHaveBeenCalledOnce();
        expect(boundedLocalApplicationActivityCount.value).toBe(1);
        expect(boundedRemoteActivityCount.value).toBe(1);

        (globalThis as any).activeWindow.document.hidden = false;
        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortStaleRemoteRequests).toHaveBeenCalledOnce();

        finishReplication();
        await vi.waitFor(() => expect(boundedLocalApplicationActivityCount.value).toBe(0));
    });

    it("sends nothing when nothing waits to be sent, and then suspends", async () => {
        const { module, appLifecycle, replicate } = hideMobileApp({ unsentLocalChanges: false });

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(1_000);

        await vi.waitFor(() => expect(appLifecycle.onSuspending).toHaveBeenCalledOnce());
        expect(replicate).not.toHaveBeenCalled();
    });

    it("waits until a storage event which arrives after saving has been stored, and then sends it", async () => {
        const { module, fileProcessing, hasUnsentLocalChanges, replicate, editor } = hideMobileApp({
            unsentLocalChanges: false,
        });
        editor.save.mockImplementationOnce(async () => {
            // The storage event of the write arrives and is queued a moment later, and is stored after that.
            setTimeout(() => {
                fileProcessing.totalStorageFileEventCount++;
                fileProcessing.totalQueued.value = 1;
            }, 150);
            setTimeout(() => {
                fileProcessing.totalQueued.value = 0;
                hasUnsentLocalChanges.mockResolvedValue(true);
            }, 350);
        });

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(200);
        expect(replicate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(900);
        expect(replicate).toHaveBeenCalledOnce();
    });

    it("stores saved editor content and sends it even when its storage event arrives after the old grace period", async () => {
        const { module, fileProcessing, hasUnsentLocalChanges, replicate, storeFileToDBUnderFileEventLock, editor } =
            hideMobileApp({
                unsentLocalChanges: false,
            });
        let storageContent = "old content";
        let databaseContent = "old content";
        const sentContents: string[] = [];
        editor.save.mockImplementationOnce(async () => {
            storageContent = "last typed content";
            setTimeout(() => {
                fileProcessing.totalStorageFileEventCount++;
                fileProcessing.totalQueued.value = 1;
            }, 4_000);
        });
        storeFileToDBUnderFileEventLock.mockImplementationOnce(async (path) => {
            expect(path).toBe("note.md");
            databaseContent = storageContent;
            hasUnsentLocalChanges.mockResolvedValue(true);
            return true;
        });
        replicate.mockImplementationOnce(async () => {
            sentContents.push(databaseContent);
            return true;
        });

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(300);
        expect(storeFileToDBUnderFileEventLock).toHaveBeenCalledOnce();
        expect(storeFileToDBUnderFileEventLock.mock.invocationCallOrder[0]).toBeLessThan(
            hasUnsentLocalChanges.mock.invocationCallOrder[0]
        );
        expect(replicate).toHaveBeenCalledOnce();
        expect(sentContents).toEqual(["last typed content"]);
        expect(fileProcessing.totalStorageFileEventCount).toBe(0);
    });

    it("does not suspend when the app becomes visible while an editor save is pending", async () => {
        const { module, appLifecycle, editor, replicate, storeFileToDBUnderFileEventLock } = hideMobileApp({
            unsentLocalChanges: true,
        });
        let finishSave!: () => void;
        editor.save.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (finishSave = () => resolve(undefined)))
        );

        const hiding = module.watchWindowVisibilityAsync();
        await vi.waitFor(() => expect(editor.save).toHaveBeenCalledOnce());
        (globalThis as any).activeWindow.document.hidden = false;
        await module.watchWindowVisibilityAsync();
        finishSave();
        await hiding;
        await vi.advanceTimersByTimeAsync(3_000);

        expect(appLifecycle.onSuspending).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
        expect(storeFileToDBUnderFileEventLock).not.toHaveBeenCalled();
    });

    it("sends what the queue still holds once it has waited long enough", async () => {
        const { module, fileProcessing, replicate } = hideMobileApp({ unsentLocalChanges: false });
        fileProcessing.totalQueued.value = 1;

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(2_800);
        expect(replicate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(400);
        expect(replicate).toHaveBeenCalledOnce();
    });

    it.each([
        ["on the desktop app", { isMobile: false }],
        ["with a CouchDB remote", { settings: { remoteType: REMOTE_COUCHDB } }],
        ["while synchronisation is suspended", { isSuspended: true }],
    ])("neither saves nor sends %s", async (_, opts) => {
        const { module, editor, replicate, storeFileToDBUnderFileEventLock } = hideMobileApp({
            unsentLocalChanges: true,
            ...opts,
        });

        await module.watchWindowVisibilityAsync();
        await vi.advanceTimersByTimeAsync(3_000);

        expect(editor.save).not.toHaveBeenCalled();
        expect(storeFileToDBUnderFileEventLock).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
    });
});
