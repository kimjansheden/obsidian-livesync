import { describe, expect, it, vi } from "vitest";
import { prepareAttachmentOffload, selectAttachmentTargets } from "./AttachmentPreparation";

function harness() {
    const events: string[] = [];
    let stopped = false,
        remote = "synthetic-remote";
    const deps = {
        remoteKey: () => remote,
        isStopped: () => stopped,
        publish: vi.fn(async () => {
            events.push("published");
            return true;
        }),
        recordPreparation: vi.fn(async () => {
            events.push("recorded");
        }),
        suspend: vi.fn(async () => {
            events.push("suspended");
            return true;
        }),
    };
    return {
        deps,
        events,
        stop: () => {
            stopped = true;
        },
        changeRemote: () => {
            remote = "other-synthetic-remote";
        },
    };
}

describe("bounded attachment preparation", () => {
    it("finishes target checks before the returned selection can retire originals", async () => {
        const events: string[] = [];
        const paths = ["archive/a.png", "ignored/b.png", "archive/c.png"];
        const selected = await selectAttachmentTargets(paths, {
            isTarget: async (path) => {
                events.push(`check:${path}`);
                return !path.startsWith("ignored/");
            },
            isStopped: () => false,
            mayRun: () => true,
            progress: async () => {},
        });
        for (const path of selected ?? []) events.push(`move:${path}`);
        expect(events).toEqual(
            paths.map((path) => `check:${path}`).concat(["move:archive/a.png", "move:archive/c.png"])
        );
        expect(selected).toEqual(["archive/a.png", "archive/c.png"]);
    });
    it("returns no partial approval after cancellation during a target check", async () => {
        let stopped = false;
        const check = vi.fn(async () => {
            stopped = true;
            return true;
        });
        expect(
            await selectAttachmentTargets(["a.png", "b.png"], {
                isTarget: check,
                isStopped: () => stopped,
                mayRun: () => true,
                progress: async () => {},
            })
        ).toBeNull();
        expect(check).toHaveBeenCalledTimes(1);
    });
    it("propagates a target policy failure without returning a partial selection", async () => {
        const check = vi.fn(async () => {
            throw new Error("synthetic target policy failure");
        });
        await expect(
            selectAttachmentTargets(["a.png", "b.png"], {
                isTarget: check,
                isStopped: () => false,
                mayRun: () => true,
                progress: async () => {},
            })
        ).rejects.toThrow("target policy failure");
        expect(check).toHaveBeenCalledTimes(1);
    });
    it("yields after bounded groups and stops when the host unloads", async () => {
        let running = true;
        const progress = vi.fn(async () => {
            running = false;
        });
        const check = vi.fn(async () => true);
        await expect(
            selectAttachmentTargets(
                Array.from({ length: 205 }, (_, i) => `images/${i}.png`),
                {
                    isTarget: check,
                    isStopped: () => false,
                    mayRun: () => running,
                    progress,
                }
            )
        ).rejects.toThrow("selection stopped");
        expect(progress).toHaveBeenCalledTimes(1);
        expect(check).toHaveBeenCalledTimes(100);
    });
    it("publishes and suspends before originals can move without enumerating remote history", async () => {
        const f = harness();
        expect(await prepareAttachmentOffload(f.deps)).toBe(true);
        expect(f.events).toEqual(["published", "recorded", "suspended"]);
    });
    it("does not begin offloading after a failed publication", async () => {
        const f = harness();
        f.deps.publish.mockResolvedValue(false);
        await expect(prepareAttachmentOffload(f.deps)).rejects.toThrow("could not be published");
        expect(f.deps.recordPreparation).not.toHaveBeenCalled();
        expect(f.deps.suspend).not.toHaveBeenCalled();
    });
    it("does not permit offloading when suspension fails", async () => {
        const f = harness();
        f.deps.suspend.mockResolvedValue(false);
        await expect(prepareAttachmentOffload(f.deps)).rejects.toThrow("could not be paused");
    });
    it("honours a stop request before changing local preparation state", async () => {
        const f = harness();
        f.stop();
        expect(await prepareAttachmentOffload(f.deps)).toBe(false);
        expect(f.deps.recordPreparation).not.toHaveBeenCalled();
        expect(f.deps.suspend).not.toHaveBeenCalled();
    });
    it("rejects a remote change while originals are being published", async () => {
        const f = harness();
        f.deps.publish.mockImplementation(async () => {
            f.changeRemote();
            return true;
        });
        await expect(prepareAttachmentOffload(f.deps)).rejects.toThrow("remote changed");
        expect(f.deps.recordPreparation).not.toHaveBeenCalled();
        expect(f.deps.suspend).not.toHaveBeenCalled();
    });
});
