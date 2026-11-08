/** Wait outside file-event locks: startup must release its own queued events before a view can restore a file. */
export async function waitForAttachmentReadiness(
    isReady: () => boolean,
    mayRun: () => boolean,
    wait: () => Promise<void>
): Promise<void> {
    while (!isReady()) {
        if (!mayRun()) throw new Error("Attachment access stopped");
        await wait();
    }
    if (!mayRun()) throw new Error("Attachment access stopped");
}
