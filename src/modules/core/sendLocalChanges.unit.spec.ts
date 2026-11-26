import { describe, expect, it, vi } from "vitest";
import { sendLocalChangesOrReplicate } from "./sendLocalChanges";

function servicesWith(sendLocalChangesNow?: () => Promise<string>) {
    const replicator = sendLocalChangesNow ? { sendLocalChangesNow: vi.fn(sendLocalChangesNow) } : undefined;
    return { replicator, services: { replicator: { getActiveReplicator: () => replicator } } as never };
}

describe("sendLocalChangesOrReplicate", () => {
    it.each(["sent", "nothing-to-send"])("requests no replication when the replicator answers %s", async (answer) => {
        const { services } = servicesWith(async () => answer);
        const replicate = vi.fn(async () => true);

        await sendLocalChangesOrReplicate(services, replicate);

        expect(replicate).not.toHaveBeenCalled();
    });

    it.each(["needs-replication", "failed"])("requests a replication when the replicator answers %s", async (answer) => {
        const { replicator, services } = servicesWith(async () => answer);
        const replicate = vi.fn(async () => true);

        await sendLocalChangesOrReplicate(services, replicate);

        expect(replicator!.sendLocalChangesNow).toHaveBeenCalledOnce();
        expect(replicate).toHaveBeenCalledOnce();
    });

    it("requests a replication when no replicator is active", async () => {
        const { services } = servicesWith();
        const replicate = vi.fn(async () => true);

        await sendLocalChangesOrReplicate(services, replicate);

        expect(replicate).toHaveBeenCalledOnce();
    });
});
