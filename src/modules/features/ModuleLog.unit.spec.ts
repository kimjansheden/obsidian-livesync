import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { handlers } from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";
import type { LiveSyncCore } from "@/main";

vi.mock("@/deps.ts", () => ({
    debounce: (callback: () => void) => callback,
    normalizePath: (path: string) => path,
    addIcon: vi.fn(),
    stringifyYaml: vi.fn(),
    Notice: class {},
}));
vi.mock("./Log/LogPaneView.ts", () => ({ LogPaneView: class {}, VIEW_TYPE_LOG: "log" }));
vi.mock("@/common/reportTool.ts", () => ({ generateReport: vi.fn() }));
vi.mock("@vrtmrz/livesync-commonlib/compat/replication/trystero/P2PLogCollector", () => ({
    P2PLogCollector: class {},
}));

import { ModuleLog } from "./ModuleLog";

type LifecycleHooks = Record<
    "onInitialise" | "onSettingLoaded" | "onLoaded" | "onBeforeUnload" | "onUnload",
    () => Promise<boolean>
>;

function createLogModule() {
    let addLogHandler: (message: unknown, level?: number, key?: string) => void = () => undefined;
    const addLog = Object.assign(
        (message: unknown, level?: number, key?: string) => addLogHandler(message, level, key),
        {
            setHandler: (callback: typeof addLogHandler) => {
                addLogHandler = callback;
            },
        }
    );
    let disposed = false;
    const noticeCalls: string[] = [];
    const notices = {
        show: vi.fn((key: string) => {
            if (disposed) throw new Error("KeyedNoticeManager has been disposed");
            noticeCalls.push(`show:${key}`);
        }),
        hide: vi.fn((key: string) => {
            if (disposed) throw new Error("KeyedNoticeManager has been disposed");
            noticeCalls.push(`hide:${key}`);
        }),
        dispose: () => {
            noticeCalls.push("dispose");
            disposed = true;
        },
    };
    const appLifecycle = {
        onInitialise: handlers<LifecycleHooks>().all("onInitialise"),
        onSettingLoaded: handlers<LifecycleHooks>().all("onSettingLoaded"),
        onLoaded: handlers<LifecycleHooks>().all("onLoaded"),
        onBeforeUnload: handlers<LifecycleHooks>().all("onBeforeUnload"),
        onUnload: handlers<LifecycleHooks>().all("onUnload"),
    };
    appLifecycle.onUnload.addHandler(() => {
        notices.dispose();
        Logger("Notice disposal completed", LOG_LEVEL_NOTICE);
        return Promise.resolve(true);
    });
    const services = {
        API: {
            addLog,
            addCommand: vi.fn(),
            registerWindow: vi.fn(),
            addRibbonIcon: vi.fn(),
            registerProtocolHandler: vi.fn(),
        },
        context: { notices, events: {} },
        appLifecycle,
        vault: { getVaultName: () => "Synthetic vault" },
    };
    const core = { _services: services, services, settings: {} } as unknown as LiveSyncCore;
    const module = new ModuleLog({ app: {} } as never, core);
    vi.spyOn(module, "observeForLogs").mockImplementation(() => undefined);
    vi.spyOn(module, "adjustStatusDivPosition").mockImplementation(() => undefined);
    module.onBindFunction(core, core.services);
    return { module, services, appLifecycle, notices, noticeCalls };
}

describe("ModuleLog teardown", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("detaches logging before notices are disposed and reports later teardown errors to the console", async () => {
        vi.stubGlobal("document", { querySelectorAll: () => [] });
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const consoleDir = vi.spyOn(console, "dir").mockImplementation(() => undefined);
        const { module, services, appLifecycle, notices, noticeCalls } = createLogModule();
        await appLifecycle.onSettingLoaded();
        Logger("Active notice", LOG_LEVEL_NOTICE, "active");
        expect(notices.show).toHaveBeenCalledWith("log:active", "Active notice", expect.anything());

        await appLifecycle.onBeforeUnload();
        await appLifecycle.onUnload();
        const teardownError = new Error("Synthetic teardown failure");
        expect(() => {
            Logger("Unloading did not complete", LOG_LEVEL_NOTICE);
            Logger(teardownError, LOG_LEVEL_VERBOSE);
            services.API.addLog("Late service notice", LOG_LEVEL_NOTICE);
            module.__addLog("Late direct notice", LOG_LEVEL_NOTICE);
        }).not.toThrow();

        expect(noticeCalls).toEqual(["show:log:active", "hide:log:active", "dispose"]);
        expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("Unloading did not complete"));
        expect(consoleDir).toHaveBeenCalledWith(teardownError.stack);
        await appLifecycle.onBeforeUnload();
        expect(notices.hide).toHaveBeenCalledOnce();
        expect(await appLifecycle.onSettingLoaded()).toBe(false);
    });

    it("does not retain an unloaded listener when another instance loads", async () => {
        vi.stubGlobal("document", { querySelectorAll: () => [] });
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const first = createLogModule();
        await first.appLifecycle.onSettingLoaded();
        await first.appLifecycle.onBeforeUnload();
        await first.appLifecycle.onUnload();
        first.notices.show.mockClear();
        const firstAddLog = vi.spyOn(first.module, "__addLog");

        const next = createLogModule();
        await next.appLifecycle.onSettingLoaded();
        Logger("Reloaded notice", LOG_LEVEL_NOTICE, "reloaded");

        expect(first.notices.show).not.toHaveBeenCalled();
        expect(firstAddLog).not.toHaveBeenCalled();
        expect(next.notices.show).toHaveBeenCalledOnce();
        await next.appLifecycle.onBeforeUnload();
    });
});
