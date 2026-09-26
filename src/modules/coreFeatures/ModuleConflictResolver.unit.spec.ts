import { describe, expect, it, vi } from "vitest";
import {
    AUTO_MERGED,
    DEFAULT_SETTINGS,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    MISSING_OR_ERROR,
    REMOTE_COUCHDB,
    REMOTE_MINIO,
    type FilePathWithPrefix,
    type MetaEntry,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { ModuleConflictResolver } from "./ModuleConflictResolver";

function createModule(files: FilePathWithPrefix[] = []) {
    const resolveByDeletingRevision = vi.fn(async () => AUTO_MERGED);
    const tryAutoMerge = vi.fn();
    const queueCheckFor = vi.fn(async () => undefined);
    const resolveByUserInteraction = vi.fn(async () => false);
    const core = {
        _services: {
            API: {
                addLog: vi.fn(),
                addCommand: vi.fn(),
                registerWindow: vi.fn(),
                addRibbonIcon: vi.fn(),
                registerProtocolHandler: vi.fn(),
            },
            setting: {
                saveSettingData: vi.fn(async () => undefined),
            },
            conflict: {
                resolveByNewest: vi.fn(async () => true),
                resolveByDeletingRevision,
                resolveByUserInteraction,
                queueCheckFor,
            },
            appLifecycle: {
                isSuspended: vi.fn(() => false),
            },
            replication: {
                replicateByEvent: vi.fn(async () => true),
            },
            vault: {
                getActiveFilePath: vi.fn(() => undefined),
            },
        },
        settings: { ...DEFAULT_SETTINGS, remoteType: REMOTE_MINIO },
        fileHandler: {
            deleteRevisionFromDB: vi.fn(async () => true),
            dbToStorage: vi.fn(async () => true),
        },
        databaseFileAccess: {
            getConflictedRevs: vi.fn(async () => []),
            storeContent: vi.fn(async () => true),
        },
        localDatabase: {
            tryAutoMerge,
        },
        storageAccess: {
            getFileNames: vi.fn(async () => files),
        },
    } as any;
    Object.defineProperty(core, "services", { get: () => core._services });

    const module = new ModuleConflictResolver(core);
    module._log = vi.fn();
    return { module, queueCheckFor, resolveByDeletingRevision, resolveByUserInteraction, tryAutoMerge };
}

describe("ModuleConflictResolver bulk newest resolution", () => {
    it("retains the success notice for a non-bulk newest resolution", async () => {
        const { module } = createModule();
        const path = "example.md" as FilePathWithPrefix;
        module.core.databaseFileAccess.fetchEntryMeta = vi.fn(
            async (_path: unknown, rev?: string): Promise<MetaEntry> =>
                ({
                    _id: "doc-id",
                    _rev: rev ?? "2-current",
                    path,
                    ctime: 1,
                    mtime: rev ? 1 : 2,
                    size: 0,
                    children: [],
                    type: "plain",
                    eden: {},
                }) as unknown as MetaEntry
        );
        module.core.databaseFileAccess.getConflictedRevs = vi
            .fn()
            .mockResolvedValueOnce(["1-old"])
            .mockResolvedValue([]);

        await (module as any)._anyResolveConflictByNewest(path);

        expect(module._log).toHaveBeenLastCalledWith(`${path} has been merged automatically`, LOG_LEVEL_NOTICE);
    });

    it("logs a successful bulk newest resolution without displaying a notice", async () => {
        const { module } = createModule();
        const path = "example.md" as FilePathWithPrefix;
        module.core.databaseFileAccess.fetchEntryMeta = vi.fn(
            async (_path: unknown, rev?: string): Promise<MetaEntry> =>
                ({
                    _id: "doc-id",
                    _rev: rev ?? "2-current",
                    path,
                    ctime: 1,
                    mtime: rev ? 1 : 2,
                    size: 0,
                    children: [],
                    type: "plain",
                    eden: {},
                }) as unknown as MetaEntry
        );
        module.core.databaseFileAccess.getConflictedRevs = vi
            .fn()
            .mockResolvedValueOnce(["1-old"])
            .mockResolvedValue([]);

        await (module as any)._anyResolveConflictByNewest(path, false);

        expect(module._log).toHaveBeenLastCalledWith(`${path} has been merged automatically`, LOG_LEVEL_INFO);
    });

    it("updates notice-level progress once every ten checked files", async () => {
        const files = Array.from({ length: 11 }, (_, index) => `note-${index}.md` as FilePathWithPrefix);
        const { module } = createModule(files);
        const resolveByNewest = vi.spyOn(module as any, "_anyResolveConflictByNewest").mockResolvedValue(true);

        await (module as any)._resolveAllConflictedFilesByNewerOnes();

        expect(resolveByNewest).toHaveBeenCalledTimes(11);
        expect(resolveByNewest).toHaveBeenCalledWith(files[0], false);
        expect(module._log).toHaveBeenCalledWith(
            "Check and Processing 10 / 11",
            LOG_LEVEL_NOTICE,
            "resolveAllConflictedFilesByNewerOnes"
        );
        expect(module._log).toHaveBeenCalledTimes(3);
    });
});

describe("ModuleConflictResolver independent same-path creation", () => {
    const path = "independently-created.md" as FilePathWithPrefix;

    function leaf(rev: string, data: string, mtime: number) {
        return {
            rev,
            data,
            mtime,
            ctime: mtime,
            deleted: false,
        } as any;
    }

    it("collapses one duplicate revision when independently created files have identical content", async () => {
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        const leftLeaf = leaf("1-left", "Same content\n", 1000);
        const rightLeaf = leaf("1-right", "Same content\n", 2000);
        tryAutoMerge.mockResolvedValue({
            leftRev: leftLeaf.rev,
            rightRev: rightLeaf.rev,
            leftLeaf,
            rightLeaf,
        });

        const result = await module.checkConflictAndPerformAutoMerge(path);

        expect(result).toBe(AUTO_MERGED);
        expect(resolveByDeletingRevision).toHaveBeenCalledOnce();
        expect(resolveByDeletingRevision).toHaveBeenCalledWith(path, "1-left", "same");
    });

    it("returns a manual diff when independently created files have different content", async () => {
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        const leftLeaf = leaf("1-left", "Left content\n", 1000);
        const rightLeaf = leaf("1-right", "Right content\n", 2000);
        tryAutoMerge.mockResolvedValue({
            leftRev: leftLeaf.rev,
            rightRev: rightLeaf.rev,
            leftLeaf,
            rightLeaf,
        });

        const result = await module.checkConflictAndPerformAutoMerge(path);

        expect(result).toMatchObject({ left: leftLeaf, right: rightLeaf });
        expect(result).toHaveProperty("diff");
        expect(resolveByDeletingRevision).not.toHaveBeenCalled();
    });
});

describe("ModuleConflictResolver remote conflict policy", () => {
    it.each([
        ["binary content", "image.png", false],
        ["newer-file setting", "note.md", true],
    ])("keeps different %s for a manual Object Storage decision", async (_, name, newerFile) => {
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        module.core.settings.remoteType = REMOTE_MINIO;
        module.core.settings.resolveConflictsByNewerFile = newerFile;
        const path = name as FilePathWithPrefix;
        tryAutoMerge.mockResolvedValue({
            leftRev: "1-left",
            rightRev: "1-right",
            leftLeaf: { rev: "1-left", data: "left", mtime: 1, deleted: false },
            rightLeaf: { rev: "1-right", data: "right", mtime: 2, deleted: false },
        });

        const result = await module.checkConflictAndPerformAutoMerge(path);

        expect(result).toHaveProperty("diff");
        expect(resolveByDeletingRevision).not.toHaveBeenCalled();
        expect(tryAutoMerge).toHaveBeenCalledWith(path, true, true);
    });

    it("keeps CouchDB's newer-file conflict resolution", async () => {
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        module.core.settings.remoteType = REMOTE_COUCHDB;
        module.core.settings.resolveConflictsByNewerFile = true;
        const path = "note.md" as FilePathWithPrefix;
        tryAutoMerge.mockResolvedValue({
            leftRev: "1-left",
            rightRev: "1-right",
            leftLeaf: { rev: "1-left", data: "left", mtime: 1, deleted: false },
            rightLeaf: { rev: "1-right", data: "right", mtime: 2, deleted: false },
        });

        await module.checkConflictAndPerformAutoMerge(path);

        expect(resolveByDeletingRevision).toHaveBeenCalledOnce();
        expect(tryAutoMerge).toHaveBeenCalledWith(path, true, false);
    });
});

describe("ModuleConflictResolver sensible merge hand-off", () => {
    it("keeps an unreadable non-winner revision unresolved", async () => {
        const path = "missing-conflict-body.md" as FilePathWithPrefix;
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        tryAutoMerge.mockResolvedValue({
            leftRev: "3-current",
            rightRev: "2-unreadable",
            leftLeaf: {
                rev: "3-current",
                data: "Readable current body\n",
                ctime: 1,
                mtime: 3,
                deleted: false,
            },
            rightLeaf: false,
        });

        const result = await module.checkConflictAndPerformAutoMerge(path);

        expect(result).toBe(MISSING_OR_ERROR);
        expect(resolveByDeletingRevision).not.toHaveBeenCalled();
    });

    it("stores the merged body on the revision it was merged on, and removes the resolved conflict leaf", async () => {
        const path = "sensible.md" as FilePathWithPrefix;
        const { module, resolveByDeletingRevision, tryAutoMerge } = createModule();
        const mergedOn = { revision: "2-left", ctime: 10, mtime: 30 };
        tryAutoMerge.mockResolvedValue({
            result: "Title\nLeft changed\nRight changed\n",
            conflictedRev: "2-right",
            mergedOn,
        });

        const result = await module.checkConflictAndPerformAutoMerge(path);

        expect(result).toBe(AUTO_MERGED);
        // The same revision and times on every device let their identical merges become one revision.
        expect(module.core.databaseFileAccess.storeContent).toHaveBeenCalledWith(
            path,
            "Title\nLeft changed\nRight changed\n",
            mergedOn
        );
        expect(resolveByDeletingRevision).toHaveBeenCalledWith(path, "2-right", "Sensible");
    });

    it("commits a sensible pair before rechecking the remaining manual pair", async () => {
        const path = "three-versions.md" as FilePathWithPrefix;
        const { module, queueCheckFor, resolveByDeletingRevision, resolveByUserInteraction, tryAutoMerge } =
            createModule();
        const remainingManualPair = {
            leftRev: "3-merged",
            rightRev: "2-third",
            leftLeaf: { rev: "3-merged", data: "Merged\n", ctime: 1, mtime: 3 },
            rightLeaf: { rev: "2-third", data: "Overlapping\n", ctime: 1, mtime: 2 },
        };
        const mergedOn = { revision: "2-first", ctime: 1, mtime: 3 };
        tryAutoMerge
            .mockResolvedValueOnce({
                result: "Merged\n",
                conflictedRev: "2-second",
                mergedOn,
            })
            .mockResolvedValueOnce(remainingManualPair);

        await (module as any)._resolveConflict(path);

        expect(module.core.databaseFileAccess.storeContent).toHaveBeenCalledWith(path, "Merged\n", mergedOn);
        expect(resolveByDeletingRevision).toHaveBeenCalledWith(path, "2-second", "Sensible");
        expect(queueCheckFor).toHaveBeenCalledWith(path);
        expect(resolveByUserInteraction).not.toHaveBeenCalled();

        await (module as any)._resolveConflict(path);

        expect(tryAutoMerge).toHaveBeenCalledTimes(2);
        expect(resolveByUserInteraction).toHaveBeenCalledWith(
            path,
            expect.objectContaining({
                left: remainingManualPair.leftLeaf,
                right: remainingManualPair.rightLeaf,
            })
        );
    });
});
