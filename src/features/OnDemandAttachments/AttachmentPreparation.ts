export interface AttachmentPreparation {
    remoteKey(): string;
    publish(): Promise<boolean>;
    isStopped(): boolean;
    recordPreparation(): Promise<void>;
    suspend(): Promise<boolean>;
}

export interface AttachmentTargetSelection {
    isTarget(path: string): Promise<boolean>;
    isStopped(): boolean;
    mayRun(): boolean;
    progress(checked: number): Promise<void>;
}

/** Evaluate target policy against the stable file listing before retiring any original. */
export async function selectAttachmentTargets(
    paths: readonly string[],
    deps: AttachmentTargetSelection
): Promise<string[] | null> {
    const selected: string[] = [];
    for (let index = 0; index < paths.length; index++) {
        if (deps.isStopped()) return null;
        if (!deps.mayRun()) throw new Error("Attachment target selection stopped");
        if (await deps.isTarget(paths[index])) selected.push(paths[index]);
        if (deps.isStopped()) return null;
        if ((index + 1) % 100 === 0) await deps.progress(index + 1);
    }
    return selected;
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
