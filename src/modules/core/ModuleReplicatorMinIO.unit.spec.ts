import { afterEach, describe, expect, it, vi } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { ModuleReplicatorMinIO } from "./ModuleReplicatorMinIO.ts";

type LifecycleState = { ready: boolean; suspended: boolean; applyingSettings: boolean };

function createModule(settings: { remoteType?: string; syncOnStart: boolean }, initial: Partial<LifecycleState> = {}) {
    const state: LifecycleState = { ready: true, suspended: false, applyingSettings: false, ...initial };
    const replicate = vi.fn(async () => true);
    const services = {
        API: {
            addLog: vi.fn(),
            addCommand: vi.fn(),
            registerWindow: vi.fn(),
            addRibbonIcon: vi.fn(),
            registerProtocolHandler: vi.fn(),
        },
        appLifecycle: {
            isReady: vi.fn(() => state.ready),
            isSuspended: vi.fn(() => state.suspended),
        },
        control: {
            isApplyingSettings: vi.fn(() => state.applyingSettings),
        },
        replication: { replicate },
        setting: {
            saveSettingData: vi.fn(async () => undefined),
        },
    };
    const core = {
        _services: services,
        services,
        settings: { remoteType: REMOTE_MINIO, ...settings },
    } as any;
    return { module: new ModuleReplicatorMinIO(core), replicate, state };
}

describe("ModuleReplicatorMinIO synchronisation when the application starts or returns", () => {
    it("synchronises from the handler it adds for the resumed application", async () => {
        const { module, replicate } = createModule({ syncOnStart: true });
        const onResumed = { addHandler: vi.fn() };
        const hub = {
            replicator: {
                getNewReplicator: { addHandler: vi.fn() },
                finiteReplicationActivityCount: reactiveSource(0),
            },
            appLifecycle: { onResumed },
        };

        module.onBindFunction(module.core as never, hub as never);
        const resumed = onResumed.addHandler.mock.calls[0][0] as () => Promise<boolean>;

        await expect(resumed()).resolves.toBe(true);
        expect(replicate).toHaveBeenCalledOnce();
    });

    it("synchronises at once at start-up, which resumes the application while it applies the settings", async () => {
        const { module, replicate } = createModule({ syncOnStart: true }, { applyingSettings: true });

        await expect(module._everyAfterResumeProcess()).resolves.toBe(true);

        expect(replicate).toHaveBeenCalledOnce();
    });

    it("synchronises at once whenever the application returns to the foreground", async () => {
        const { module, replicate, state } = createModule({ syncOnStart: true }, { applyingSettings: true });
        await module._everyAfterResumeProcess();
        state.applyingSettings = false;

        await module._everyAfterResumeProcess();
        await module._everyAfterResumeProcess();

        expect(replicate).toHaveBeenCalledTimes(3);
    });

    it("does not synchronise when saved settings are applied after the start-up", async () => {
        const { module, replicate } = createModule({ syncOnStart: true }, { applyingSettings: true });
        await module._everyAfterResumeProcess();

        await module._everyAfterResumeProcess();

        expect(replicate).toHaveBeenCalledOnce();
    });

    it("counts the start-up only once the application is ready", async () => {
        const { module, replicate, state } = createModule(
            { syncOnStart: true },
            { ready: false, applyingSettings: true }
        );
        await module._everyAfterResumeProcess();
        expect(replicate).not.toHaveBeenCalled();

        state.ready = true;
        await module._everyAfterResumeProcess();

        expect(replicate).toHaveBeenCalledOnce();
    });

    it.each([
        ["synchronisation on start is off", { syncOnStart: false }, {}],
        ["synchronisation is suspended", { syncOnStart: true }, { suspended: true }],
        ["the remote is not Object Storage", { syncOnStart: true, remoteType: REMOTE_COUCHDB }, {}],
    ])("does not synchronise when %s", async (_, settings, state) => {
        const { module, replicate } = createModule(settings, state);

        await expect(module._everyAfterResumeProcess()).resolves.toBe(true);

        expect(replicate).not.toHaveBeenCalled();
    });
});

describe("ModuleReplicatorMinIO continuing after a synchronisation which received content put off", () => {
    type Host = { mobile: boolean; hidden: boolean; continuation: boolean; hasReplicator: boolean };

    /** A module bound to a replicator service whose finite replication count the test changes. */
    function createBoundModule(
        settings: { remoteType?: string } = {},
        initial: Partial<LifecycleState> = {},
        initialHost: Partial<Host> = {}
    ) {
        const { module, replicate, state } = createModule({ syncOnStart: false, ...settings }, initial);
        const host: Host = { mobile: false, hidden: false, continuation: true, hasReplicator: true, ...initialHost };
        const finiteReplicationActivityCount = reactiveSource(0);
        // The replicator answers once and clears its answer, as a real one does.
        const takeDeferredReceiveContinuation = vi.fn(() => {
            const continuation = host.continuation;
            host.continuation = false;
            return continuation;
        });
        const services = module.core.services as any;
        services.API.isMobile = vi.fn(() => host.mobile);
        // Asking for the replicator in order to replicate reports a missing one as an error; looking for it does not.
        const getActiveReplicator = vi.fn(() => undefined);
        services.replicator = {
            finiteReplicationActivityCount,
            getNewReplicator: { addHandler: vi.fn() },
            getActiveReplicator,
            peekActiveReplicator: vi.fn(() => (host.hasReplicator ? { takeDeferredReceiveContinuation } : undefined)),
        };
        services.appLifecycle.onResumed = { addHandler: vi.fn() };
        (globalThis as any).activeWindow = { document: { hidden: host.hidden } };
        module.onBindFunction(module.core as never, services as never);
        /** One synchronisation, as the replicator service counts it. */
        const runSynchronisation = () => {
            finiteReplicationActivityCount.value++;
            finiteReplicationActivityCount.value--;
        };
        return {
            module,
            replicate,
            state,
            host,
            finiteReplicationActivityCount,
            getActiveReplicator,
            takeDeferredReceiveContinuation,
            runSynchronisation,
        };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    afterEach(() => {
        delete (globalThis as any).activeWindow;
    });

    it("synchronises again at once when the synchronisation which just ended received such content", async () => {
        const { replicate, runSynchronisation, takeDeferredReceiveContinuation } = createBoundModule();

        runSynchronisation();
        await settle();

        expect(replicate).toHaveBeenCalledOnce();
        expect(takeDeferredReceiveContinuation).toHaveBeenCalledOnce();
    });

    it("stops once a synchronisation received none", async () => {
        const { replicate, runSynchronisation } = createBoundModule();

        runSynchronisation();
        runSynchronisation();
        await settle();

        expect(replicate).toHaveBeenCalledOnce();
    });

    it("waits until no finite replication is running any more", async () => {
        const { replicate, finiteReplicationActivityCount, takeDeferredReceiveContinuation } = createBoundModule();

        finiteReplicationActivityCount.value = 2;
        finiteReplicationActivityCount.value = 1;
        await settle();
        expect(takeDeferredReceiveContinuation).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();

        finiteReplicationActivityCount.value = 0;
        await settle();
        expect(replicate).toHaveBeenCalledOnce();
    });

    it.each<[string, Partial<LifecycleState>, Partial<Host>]>([
        ["the application is suspended", { suspended: true }, {}],
        ["the application is not ready", { ready: false }, {}],
        ["the mobile application is hidden", {}, { mobile: true, hidden: true }],
    ])("starts no synchronisation while %s", async (_case, lifecycle, host) => {
        const { replicate, runSynchronisation } = createBoundModule({}, lifecycle, host);

        runSynchronisation();
        await settle();

        expect(replicate).not.toHaveBeenCalled();
    });

    it("does not keep a hidden mobile application synchronising, and goes on when it is shown again", async () => {
        const { replicate, host, runSynchronisation } = createBoundModule({}, {}, { mobile: true, hidden: true });

        for (let cycle = 0; cycle < 3; cycle++) {
            host.continuation = true;
            runSynchronisation();
        }
        await settle();
        expect(replicate).not.toHaveBeenCalled();

        // The application is shown again, and the synchronisation which that starts receives more.
        (globalThis as any).activeWindow.document.hidden = false;
        host.continuation = true;
        runSynchronisation();
        await settle();
        expect(replicate).toHaveBeenCalledOnce();
    });

    it.each<[string, Partial<Host>]>([
        ["a hidden desktop application", { mobile: false, hidden: true }],
        ["a mobile application which is shown", { mobile: true, hidden: false }],
    ])("goes on in %s", async (_case, host) => {
        const { replicate, runSynchronisation } = createBoundModule({}, {}, host);

        runSynchronisation();
        await settle();

        expect(replicate).toHaveBeenCalledOnce();
    });

    it("goes on in a host which has no application window", async () => {
        const { replicate, runSynchronisation } = createBoundModule({}, {}, { mobile: true });
        delete (globalThis as any).activeWindow;

        runSynchronisation();
        await settle();

        expect(replicate).toHaveBeenCalledOnce();
    });

    it("leaves a remote which is not Object Storage alone", async () => {
        const { replicate, runSynchronisation, takeDeferredReceiveContinuation } = createBoundModule({
            remoteType: REMOTE_COUCHDB,
        });

        runSynchronisation();
        await settle();

        expect(takeDeferredReceiveContinuation).not.toHaveBeenCalled();
        expect(replicate).not.toHaveBeenCalled();
    });

    it("starts nothing when no replicator is active, and does not report that as an error", async () => {
        const { replicate, runSynchronisation, getActiveReplicator } = createBoundModule(
            {},
            {},
            { hasReplicator: false }
        );

        expect(() => runSynchronisation()).not.toThrow();
        await settle();

        expect(replicate).not.toHaveBeenCalled();
        expect(getActiveReplicator).not.toHaveBeenCalled();
    });

    describe("and the replicator it creates for Object Storage", () => {
        it.each<[string, Partial<Host>, boolean]>([
            ["a mobile application which is hidden", { mobile: true, hidden: true }, false],
            ["a mobile application which is shown", { mobile: true, hidden: false }, true],
            ["a hidden desktop application", { mobile: false, hidden: true }, true],
        ])("tells whether content which is put off may be received in %s", async (_case, host, expected) => {
            const { module } = createBoundModule({}, {}, host);

            const replicator = await module._anyNewReplicator();

            expect(replicator && replicator.mayReceiveDeferredContent()).toBe(expected);
        });

        it("answers for the moment it is asked, as when the application is hidden during a synchronisation", async () => {
            const { module } = createBoundModule({}, {}, { mobile: true });
            const replicator = await module._anyNewReplicator();
            if (!replicator) throw new Error("No replicator was created");
            expect(replicator.mayReceiveDeferredContent()).toBe(true);

            // The application is hidden, and synchronises once more to send what was written.
            (globalThis as any).activeWindow.document.hidden = true;
            expect(replicator.mayReceiveDeferredContent()).toBe(false);

            (globalThis as any).activeWindow.document.hidden = false;
            expect(replicator.mayReceiveDeferredContent()).toBe(true);
        });

        it("allows it in a host which has no application window", async () => {
            const { module } = createBoundModule({}, {}, { mobile: true });
            delete (globalThis as any).activeWindow;

            const replicator = await module._anyNewReplicator();

            expect(replicator && replicator.mayReceiveDeferredContent()).toBe(true);
        });

        it("creates no replicator for another kind of remote", async () => {
            const { module } = createBoundModule({ remoteType: REMOTE_COUCHDB });

            await expect(module._anyNewReplicator()).resolves.toBe(false);
        });
    });
});
