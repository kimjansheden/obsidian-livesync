import { describe, expect, it, vi } from "vitest";
import { prepareAttachmentOffload } from "./AttachmentPreparation";

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
