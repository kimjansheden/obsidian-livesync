import { describe, expect, it, vi } from "vitest";
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
            replicator: { getNewReplicator: { addHandler: vi.fn() } },
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
