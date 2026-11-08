export interface AttachmentBatchResult {
    moved: number;
    retained: number;
    stopped: boolean;
}

/** A stop request finishes the current atomic file operation, then starts no further paths. */
export class AttachmentBatch {
    private stopped = false;

    stop(): void {
        this.stopped = true;
    }

    get isStopped(): boolean {
        return this.stopped;
    }

    async run(
        paths: readonly string[],
        process: (path: string) => Promise<boolean>,
        mayRun: () => boolean,
        progress: (processed: number) => Promise<void>
    ): Promise<AttachmentBatchResult> {
        let moved = 0,
            retained = 0;
        for (const path of paths) {
            if (this.stopped) break;
            if (!mayRun()) throw new Error("Attachment offloading stopped");
            if (await process(path)) moved++;
            else retained++;
            if ((moved + retained) % 100 === 0) await progress(moved + retained);
        }
        return { moved, retained, stopped: this.stopped };
    }
}
