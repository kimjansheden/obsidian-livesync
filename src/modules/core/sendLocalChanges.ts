import type { LocalChangeSendOutcome } from "@vrtmrz/livesync-commonlib/compat/replication/LiveSyncAbstractReplicator";

/** What the decision needs of the services: the active replicator and its immediate send. */
type ReplicatorServices = {
    replicator: {
        getActiveReplicator(): { sendLocalChangesNow(): Promise<LocalChangeSendOutcome> } | undefined | false;
    };
};

/**
 * Send the local changes at once when the active replicator can, and request a replication otherwise.
 *
 * An Object Storage replicator sends beside a synchronisation which is receiving, once that synchronisation's
 * listing has shown the remote of this device, so a save or a hidden mobile app does not wait for the whole receive
 * before what was written leaves the device. When no such synchronisation runs, or the send fails, `replicate`
 * requests one, which sends the changes as before.
 */
export async function sendLocalChangesOrReplicate(
    services: ReplicatorServices,
    replicate: () => Promise<unknown>
): Promise<void> {
    const replicator = services.replicator.getActiveReplicator();
    const outcome = replicator ? await replicator.sendLocalChangesNow() : undefined;
    if (outcome === "sent" || outcome === "nothing-to-send") return;
    await replicate();
}
