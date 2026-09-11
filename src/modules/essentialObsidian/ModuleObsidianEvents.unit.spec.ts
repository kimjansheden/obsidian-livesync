import { describe, it, expect, vi, afterEach } from "vitest";

import { ModuleObsidianEvents } from "./ModuleObsidianEvents";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

type SetupOptions = {
    settings?: Partial<typeof DEFAULT_SETTINGS>;
    hidden: boolean;
    isLastHidden?: boolean;
    hasFocus?: boolean;
    isSuspended?: boolean;
    // Platform is read via services.API.isMobile(); default desktop (false) so the feature applies.
    isMobile?: boolean;
    abortedStaleRequests?: number;
};

function setup(opts: SetupOptions) {
    const appLifecycle = {
        isReady: vi.fn(() => true),
        isSuspended: vi.fn(() => opts.isSuspended ?? false),
        onSuspending: vi.fn(async () => true),
        onResuming: vi.fn(async () => true),
        onResumed: vi.fn(async () => true),
    };
    const fileProcessing = { commitPendingFileEvents: vi.fn(async () => true) };
    const boundedRemoteActivityCount = reactiveSource(0);
    const boundedLocalApplicationActivityCount = reactiveSource(0);
    const finiteReplicationActivityCount = reactiveSource(0);
    const abortStaleRemoteRequests = vi.fn((_startedBefore: number) => opts.abortedStaleRequests ?? 0);
    const replicate = vi.fn(async () => true);

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
                getActiveReplicator: () => ({ abortStaleRemoteRequests }),
            },
            replication: { replicate },
        },
        settings: {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_COUCHDB,
            isConfigured: true,
            ...opts.settings,
        },
    } as any;
    Object.defineProperty(core, "services", { get: () => core._services });

    const module = new ModuleObsidianEvents({} as any, core);
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
        abortStaleRemoteRequests,
        replicate,
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
