import { describe, expect, it, vi } from "vitest";
import { AttachmentBatch } from "./AttachmentBatch";

describe("attachment offloading cancellation", () => {
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
