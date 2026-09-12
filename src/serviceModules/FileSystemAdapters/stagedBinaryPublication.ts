import type { DataAdapter, Stat } from "obsidian";
import type { BinaryPublication } from "@vrtmrz/livesync-commonlib/compat/interfaces/StorageAccess";
import type { UXDataWriteOptions } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { toIntegerTimestamps } from "./sanitizeWriteOptions";

const STAGING_ROOT = ".trash/.livesync-staging";
const OWN_STAGE = /^[0-9a-f]{8}-[0-9a-f-]{27}\.stage$/u;

type NativeStat = {
    size: number;
    mtime?: number;
    ctime?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    birthtimeMs?: number;
    type?: string;
    isFile?: () => boolean;
    isDirectory?: () => boolean;
};
type NativeFiles = {
    stat(path: string): Promise<NativeStat>;
    rename(from: string, to: string): Promise<void>;
};
type PublicationAdapter = DataAdapter & {
    queue<T>(operation: () => Promise<T>): Promise<T>;
    getFullPath(path: string): string;
    reconcileInternalFile(path: string): Promise<void>;
    fsPromises?: NativeFiles;
    fs?: NativeFiles;
};

function publicationAdapter(adapter: DataAdapter): PublicationAdapter {
    const candidate = adapter as Partial<PublicationAdapter>;
    const native = candidate.fsPromises ?? candidate.fs;
    if (
        typeof candidate.queue !== "function" ||
        typeof candidate.getFullPath !== "function" ||
        typeof candidate.reconcileInternalFile !== "function" ||
        typeof native?.stat !== "function" ||
        typeof native.rename !== "function"
    ) {
        throw new Error("This Obsidian adapter cannot publish staged binary files safely");
    }
    return candidate as PublicationAdapter;
}

async function nativeStat(native: NativeFiles, path: string): Promise<Stat | null> {
    try {
        const stat = await native.stat(path);
        const type =
            stat.type === "file" || stat.isFile?.()
                ? "file"
                : stat.type === "directory" || stat.isDirectory?.()
                  ? "folder"
                  : undefined;
        const mtime = stat.mtimeMs ?? stat.mtime;
        const ctime = stat.birthtimeMs ?? stat.ctime;
        if (!type || !Number.isFinite(mtime) || !Number.isFinite(ctime) || !Number.isFinite(stat.size)) {
            throw new Error("The native target state cannot be verified");
        }
        return { type, size: stat.size, mtime: Math.round(mtime!), ctime: Math.round(ctime!) };
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

function sameTarget(actual: Stat | null, expected: Stat | null): boolean {
    if (!actual || !expected) return actual === expected;
    return (
        actual.type === "file" &&
        expected.type === "file" &&
        actual.size === expected.size &&
        actual.mtime === expected.mtime &&
        actual.ctime === expected.ctime
    );
}

/** Stages outside all sync selections; only complete files ever occupy the target path. */
export class StagedBinaryPublication {
    private initialised?: Promise<void>;
    constructor(private readonly adapter: DataAdapter) {}

    private async prepare(): Promise<void> {
        for (const dir of [".trash", STAGING_ROOT]) {
            const stat = await this.adapter.stat(dir);
            if (stat && stat.type !== "folder") throw new Error("The staging directory is occupied by a file");
            if (!stat) await this.adapter.mkdir(dir);
        }
        // One initial cleanup before any write starts. Never remove a directory or an unrecognised file.
        const listed = await this.adapter.list(STAGING_ROOT);
        for (const path of listed.files) {
            if (!path.startsWith(STAGING_ROOT + "/") || !OWN_STAGE.test(path.slice(STAGING_ROOT.length + 1))) continue;
            if ((await this.adapter.stat(path))?.type === "file") await this.adapter.remove(path);
        }
    }

    async write(
        path: string,
        parts: AsyncIterable<Uint8Array>,
        publication: BinaryPublication,
        options?: UXDataWriteOptions
    ): Promise<boolean> {
        const adapter = publicationAdapter(this.adapter);
        const native = (adapter.fsPromises ?? adapter.fs)!;
        // Failed initialisation is retried by the next ordinary file operation.
        this.initialised ??= this.prepare().catch((error) => {
            this.initialised = undefined;
            throw error;
        });
        await this.initialised;
        const stage = STAGING_ROOT + "/" + crypto.randomUUID() + ".stage";
        let size = 0;
        let started = false;
        try {
            for await (const raw of parts) {
                const part = raw as Uint8Array<ArrayBuffer>;
                const buffer =
                    part.byteOffset === 0 && part.byteLength === part.buffer.byteLength
                        ? part.buffer
                        : part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
                size += part.byteLength;
                if (size > publication.size) throw new Error("The staged content exceeds its recorded size");
                if (!started) {
                    await adapter.writeBinary(stage, buffer);
                    started = true;
                } else await adapter.appendBinary(stage, buffer);
            }
            if (size !== publication.size) throw new Error("The staged content does not match its recorded size");
            if (!started) await adapter.writeBinary(stage, new ArrayBuffer(0));
            await adapter.appendBinary(stage, new ArrayBuffer(0), toIntegerTimestamps(options));
            const staged = await adapter.stat(stage);
            if (!staged || staged.type !== "file" || staged.size !== size)
                throw new Error("The staged file is incomplete");

            return await adapter.queue(async () => {
                const target = adapter.getFullPath(path);
                if (!sameTarget(await nativeStat(native, target), publication.expectedTarget)) return false;
                // No adapter call in this callback: re-entering its queue would deadlock publication.
                await publication.beforePublish();
                // Android can delete the destination first. The durable mark makes that gap recoverable.
                await native.rename(adapter.getFullPath(stage), target);
                const published = await nativeStat(native, target);
                if (!published || published.type !== "file" || published.size !== size)
                    throw new Error("The published file could not be verified");
                await publication.afterPublish(published);
                await adapter.reconcileInternalFile(path);
                return true;
            });
        } finally {
            // A killed process leaves only its hidden stage; prepare() removes that on the next run.
            try {
                if ((await adapter.stat(stage))?.type === "file") await adapter.remove(stage);
            } catch {
                /* Cleanup failure cannot turn a complete target into a failed publication. */
            }
        }
    }
}
