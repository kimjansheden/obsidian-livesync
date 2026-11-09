export interface AttachmentPreparation {
    remoteKey(): string;
    publish(): Promise<boolean>;
    isStopped(): boolean;
    recordPreparation(): Promise<void>;
    suspend(): Promise<boolean>;
}

/** Publishing preserved originals and pausing writers does not require a full legacy R2 index. */
export async function prepareAttachmentOffload(deps: AttachmentPreparation): Promise<boolean> {
    const remote = deps.remoteKey();
    if (!(await deps.publish())) throw new Error("Attachment originals could not be published before offloading");
    if (deps.isStopped()) return false;
    if (deps.remoteKey() !== remote) throw new Error("The remote changed during attachment preparation");
    await deps.recordPreparation();
    if (!(await deps.suspend())) throw new Error("Synchronisation could not be paused for attachment preparation");
    return true;
}
