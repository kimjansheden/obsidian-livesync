import { describe, expect, it, vi } from "vitest";
import { AttachmentBatch } from "./AttachmentBatch";

describe("attachment offloading cancellation", () => {
    it("bounds concurrent file work and settles each in-flight file after cancellation", async () => {
        const batch = new AttachmentBatch();
        let finish!: () => void;
        const current = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const process = vi.fn(async () => {
            await current;
            return true;
        });
        const running = batch.run(
            ["a.png", "b.png", "c.png", "d.png", "e.png"],
            process,
            () => true,
            async () => {},
            4
        );
        expect(process).toHaveBeenCalledTimes(4);
        batch.stop();
        finish();
        expect(await running).toEqual({ moved: 4, retained: 0, stopped: true });
        expect(process).toHaveBeenCalledTimes(4);
    });
    it("awaits other in-flight originals before exposing a parallel failure", async () => {
        const batch = new AttachmentBatch();
        let finish!: () => void;
        const current = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let settled = false;
        const process = vi.fn(async (path: string) => {
            if (path === "a.png") throw new Error("synthetic failure");
            await current;
            settled = true;
            return true;
        });
        const running = batch.run(
            ["a.png", "b.png", "c.png"],
            process,
            () => true,
            async () => {},
            2
        );
        const assertion = expect(running).rejects.toThrow("synthetic failure");
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(process).toHaveBeenCalledTimes(2);
        finish();
        await assertion;
        expect(settled).toBe(true);
        expect(process).toHaveBeenCalledTimes(2);
    });
    it("completes each path exactly once with parallel work and accurate totals", async () => {
        const batch = new AttachmentBatch();
        const paths = Array.from({ length: 205 }, (_, i) => `images/example-${i}.png`);
        const process = vi.fn(async (path: string) => path !== paths[0]);
        const progress = vi.fn(async (_processed: number) => {});
        expect(await batch.run(paths, process, () => true, progress, 4)).toEqual({
            moved: 204,
            retained: 1,
            stopped: false,
        });
        expect(new Set(process.mock.calls.map(([path]) => path))).toEqual(new Set(paths));
        expect(process).toHaveBeenCalledTimes(paths.length);
        expect(progress.mock.calls.map(([count]) => count)).toEqual([100, 200]);
    });
    it("settles the current file and starts no subsequent file after a stop request", async () => {
        const batch = new AttachmentBatch();
        let finish!: () => void;
        const current = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const process = vi.fn(async () => {
            await current;
            return true;
        });
        const running = batch.run(
            ["one.png", "two.png"],
            process,
            () => true,
            async () => {}
        );
        expect(process).toHaveBeenCalledTimes(1);
        batch.stop();
        finish();
        expect(await running).toEqual({ moved: 1, retained: 0, stopped: true });
        expect(process).toHaveBeenCalledTimes(1);
    });
    it("does no file work when preparation has already been cancelled", async () => {
        const batch = new AttachmentBatch(),
            process = vi.fn();
        batch.stop();
        expect(
            await batch.run(
                ["one.png"],
                process,
                () => true,
                async () => {}
            )
        ).toEqual({ moved: 0, retained: 0, stopped: true });
        expect(process).not.toHaveBeenCalled();
    });
    it("keeps an IO failure visible instead of reporting completion", async () => {
        const batch = new AttachmentBatch();
        const process = vi.fn(async () => {
            throw new Error("synthetic interrupted rename");
        });
        await expect(
            batch.run(
                ["one.png", "two.png"],
                process,
                () => true,
                async () => {}
            )
        ).rejects.toThrow("interrupted");
        expect(process).toHaveBeenCalledTimes(1);
    });
});
