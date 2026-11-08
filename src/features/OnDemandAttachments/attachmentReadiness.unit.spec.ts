import { describe, expect, it, vi } from "vitest";
import { waitForAttachmentReadiness } from "./attachmentReadiness";

describe("attachment view readiness", () => {
    it("waits for delayed database readiness after the initial resume and checks readiness again for later resets", async () => {
        let ready = false;
        const wait = vi.fn(() => {
            ready = true;
            return Promise.resolve();
        });
        await waitForAttachmentReadiness(
            () => ready,
            () => true,
            wait
        );
        ready = false;
        await waitForAttachmentReadiness(
            () => ready,
            () => true,
            wait
        );
        expect(wait).toHaveBeenCalledTimes(2);
    });
    it("stops an outstanding view request when the plug-in unloads", async () => {
        let active = true;
        const wait = vi.fn(() => {
            active = false;
            return Promise.resolve();
        });
        await expect(
            waitForAttachmentReadiness(
                () => false,
                () => active,
                wait
            )
        ).rejects.toThrow("stopped");
        expect(wait).toHaveBeenCalledOnce();
    });
});
