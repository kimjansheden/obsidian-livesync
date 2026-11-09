export interface AttachmentBatchResult {
    moved: number;
    retained: number;
    stopped: boolean;
}

/** A stop request settles all in-flight file operations before returning. */
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
        progress: (processed: number) => Promise<void>,
        concurrency = 1
    ): Promise<AttachmentBatchResult> {
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
            throw new Error("Invalid attachment preparation concurrency");
        let moved = 0,
            retained = 0,
            next = 0;
        let failed = false;
        const worker = async () => {
            try {
                while (!this.stopped && !failed && next < paths.length) {
                    if (!mayRun()) throw new Error("Attachment offloading stopped");
                    const path = paths[next++];
                    if (await process(path)) moved++;
                    else retained++;
                    if ((moved + retained) % 100 === 0) await progress(moved + retained);
                }
            } catch (error) {
                failed = true;
                throw error;
            }
        };
        const results = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return { moved, retained, stopped: this.stopped };
    }
}
