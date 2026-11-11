import type { DataAdapter } from "obsidian";
import { readBoundedBytes } from "@/common/boundedStream";
import { MAX_PACKAGE_BYTES } from "./releaseRuntime";

/** Reads owned runtime assets through Android's local resource server without Base64 bridge copies. */
export class LocalRuntimeReader {
    private stopped = false;
    private readonly controllers = new Set<AbortController>();
    private readonly pending = new Set<Promise<ArrayBuffer>>();
    constructor(
        private readonly adapter: Pick<DataAdapter, "readBinary" | "getResourcePath">,
        private readonly pluginDirectory: string
    ) {}

    private localResource(path: string): string | undefined {
        const prefix = `${this.pluginDirectory}/`;
        if (!path.startsWith(prefix)) return;
        const name = path.slice(prefix.length);
        if (name !== "trusted-release-keys.json" && !/^release-runtime\/[a-f0-9]{64}\.livesync-release$/u.test(name))
            return;
        try {
            const resource = new URL(this.adapter.getResourcePath(path));
            if (
                !["http:", "https:", "capacitor:"].includes(resource.protocol) ||
                resource.hostname !== "localhost" ||
                resource.username ||
                resource.password ||
                !resource.pathname.startsWith("/_capacitor_file_/")
            )
                return;
            return resource.href;
        } catch {
            return;
        }
    }

    read(path: string): Promise<ArrayBuffer> {
        if (this.stopped) return Promise.reject(new Error("Runtime asset reading stopped"));
        const resource = this.localResource(path);
        const task = (resource ? this.fetchLocal(resource) : this.adapter.readBinary(path)).finally(() => {
            this.pending.delete(task);
        });
        this.pending.add(task);
        return task;
    }

    private async fetchLocal(resource: string): Promise<ArrayBuffer> {
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            const response = await window.fetch(resource, {
                signal: controller.signal,
                cache: "no-store",
                redirect: "error",
            });
            if (!response.ok || !response.body) throw new Error("The local runtime asset could not be read");
            return await readBoundedBytes(response.body, MAX_PACKAGE_BYTES);
        } finally {
            this.controllers.delete(controller);
        }
    }

    get hasPendingReads(): boolean {
        return this.pending.size > 0;
    }
    stop(): void {
        this.stopped = true;
        for (const controller of this.controllers) controller.abort();
    }
    async waitForIdle(): Promise<void> {
        await Promise.allSettled([...this.pending]);
    }
}
