import { describe, expect, it, vi } from "vitest";
import type {
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { ServiceFileHandlerDependencies } from "@vrtmrz/livesync-commonlib/compat/serviceModules/ServiceFileHandlerBase";
import { createLiveSyncEventHub } from "@vrtmrz/livesync-commonlib/context";
import { ServiceFileHandler } from "./FileHandler";

function createMeta(path: string, rev: string, deleted = false): MetaEntry {
    return {
        _id: path,
        _rev: rev,
        path,
        ctime: 1,
        mtime: 2,
        size: 4,
        children: [],
        datatype: "plain",
        type: "plain",
        eden: {},
        deleted,
    } as unknown as MetaEntry;
}

function createStorageFile(path: string, body: string): UXFileInfo {
    return {
        name: path.split("/").pop() ?? path,
        path,
        stat: { ctime: 1, mtime: 3, size: new Blob([body]).size, type: "file" },
        body: new Blob([body]),
    } as UXFileInfo;
}

// Exercises the rename path of the qualified Commonlib release that this plugin ships.
function createRenameHandler(entries: Record<string, MetaEntry>) {
    const databaseFileAccess = {
        fetchEntryMeta: vi.fn(async (path: UXFileInfoStub | FilePathWithPrefix) => {
            const filePath = typeof path === "string" ? path : path.path;
            return entries[filePath] ?? false;
        }),
        getConflictedRevs: vi.fn(async () => []),
        fetchEntry: vi.fn(async (path: string) => entries[path] ?? false),
        delete: vi.fn(async () => true),
        storeWithBaseRevision: vi.fn(async () => "4-renamed"),
    };
    const deps = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess,
        storageAccess: {},
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict: {},
        path: { path2id: vi.fn(async (path: string) => path) },
        setting: { currentSettings: vi.fn(() => ({})) },
        vault: { isTargetFile: vi.fn(async () => true) },
    } as unknown as ServiceFileHandlerDependencies;
    const handler = new ServiceFileHandler(deps);
    const storeFileToDB = vi.spyOn(handler, "storeFileToDB");
    return { handler, databaseFileAccess, storeFileToDB };
}

describe("LiveSync rename name-collision handling", () => {
    it("refuses to overwrite a live entry at the rename target and keeps the source", async () => {
        const { handler, databaseFileAccess, storeFileToDB } = createRenameHandler({
            "notes/Ångström.md": createMeta("notes/Ångström.md", "2-source"),
            "notes/Ångström-renamed.md": createMeta("notes/Ångström-renamed.md", "3-other-device"),
        });

        await expect(
            handler.renameFileInDB(
                createStorageFile("notes/Ångström-renamed.md", "renamed body"),
                "notes/Ångström.md" as FilePath
            )
        ).resolves.toBe(false);

        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
    });

    it("renames onto a deleted target by storing the target before removing the source", async () => {
        const { handler, databaseFileAccess, storeFileToDB } = createRenameHandler({
            "notes/Ångström.md": createMeta("notes/Ångström.md", "2-source"),
            "notes/Ångström-renamed.md": createMeta("notes/Ångström-renamed.md", "3-deleted", true),
        });
        storeFileToDB.mockResolvedValue(true);

        await expect(
            handler.renameFileInDB(
                createStorageFile("notes/Ångström-renamed.md", "renamed body"),
                "notes/Ångström.md" as FilePath
            )
        ).resolves.toBe(true);

        expect(storeFileToDB).toHaveBeenCalledTimes(1);
        expect(databaseFileAccess.delete).toHaveBeenCalledWith("notes/Ångström.md");
        expect(storeFileToDB.mock.invocationCallOrder[0]).toBeLessThan(
            databaseFileAccess.delete.mock.invocationCallOrder[0]
        );
    });
});
