import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/features/SetupManager.ts", () => ({
    SetupManager: class SetupManager {},
}));
vi.mock("@/deps.ts", () => ({}));
vi.mock("@/common/utils.ts", () => ({
    isValidPath: () => true,
}));

import { ModuleMigration } from "./ModuleMigration.ts";
import { REMOTE_MINIO, REMOTE_COUCHDB, REMOTE_P2P } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { COMPROMISED_CHUNK_SCAN_RECEIPT_KEY } from "@vrtmrz/livesync-commonlib/compat/pouchdb/negotiation";

async function* noDocuments() {
    return;
}

async function* failedDocumentScan() {
    throw new Error("scan failed");
}

function createMigration(
    findAllNormalDocs: () => AsyncGenerator<unknown, void, unknown> = noDocuments,
    settings = { sendChunksBulk: false, sendChunksBulkMaxSize: 1 }
) {
    const noticeGroups = {
        setItem: vi.fn(),
        finish: vi.fn(() => true),
    };
    const services = {
        API: {
            addLog: vi.fn(),
            addCommand: vi.fn(),
            registerWindow: vi.fn(),
            addRibbonIcon: vi.fn(),
            registerProtocolHandler: vi.fn(),
        },
        context: { noticeGroups },
        appLifecycle: { hasUnloaded: vi.fn(() => false), isSuspended: vi.fn(() => false) },
        setting: { saveSettingData: vi.fn(async () => undefined) },
        replication: { replicateByEvent: vi.fn(async () => true) },
        vault: { isTargetFile: vi.fn(async () => true) },
        path: { getPath: vi.fn((entry: { path: string }) => entry.path) },
    };
    const askSelectStringDialogue = vi.fn(
        async (_message: string, _buttons: string[], _options: unknown): Promise<string | undefined> => undefined
    );
    const core = {
        _services: services,
        services,
        kvDB: {
            get: vi.fn(async () => false),
            set: vi.fn(async () => undefined),
        },
        localDatabase: {
            findAllNormalDocs,
            getDBEntryFromMeta: vi.fn(async (entry: { size: number }) => ({
                type: "plain",
                data: ["hello"],
                size: entry.size,
            })),
        },
        storageAccess: {
            statHidden: vi.fn(async () => ({ type: "file" as const, size: 4, ctime: 1, mtime: 2 })),
            readHiddenFileBinary: vi.fn(async () => new Uint8Array(4)),
        },
        confirm: { askSelectStringDialogue },
        settings,
    };
    return {
        migration: new ModuleMigration(core as never),
        noticeGroups,
        replicateByEvent: services.replication.replicateByEvent,
        kvGet: core.kvDB.get,
        askSelectStringDialogue,
        saveSettingData: services.setting.saveSettingData,
        lifecycle: services.appLifecycle,
        storageStat: core.storageAccess.statHidden,
        readStorage: core.storageAccess.readHiddenFileBinary,
        loadDocument: core.localDatabase.getDBEntryFromMeta,
        kvSet: core.kvDB.set,
    };
}

function createChunkSafetyMigration(remoteType: string = REMOTE_MINIO) {
    const h = createMigration();
    const receipts = new Map<string, unknown>();
    const pouch = {
        id: vi.fn(async () => "synthetic-plugin-db"),
        info: vi.fn(async () => ({ update_seq: 174_019, doc_count: 174_019 })),
        find: vi.fn(async () => ({ docs: [] as unknown[] })),
        allDocs: vi.fn(async () => ({ rows: [] })),
        changes: vi.fn(async () => ({ results: [], last_seq: 174_019 })),
    };
    Object.assign(h.migration.settings, {
        remoteType,
        encrypt: true,
        isConfigured: true,
        doctorProcessedVersion: "approved-release-20",
    });
    Object.assign(h.migration.core.localDatabase, { localDatabase: pouch, isReady: true });
    Object.assign(h.migration.core.kvDB, {
        get: vi.fn(async (key: string) => receipts.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
            receipts.set(key, value);
        }),
    });
    const remoteCount = vi.fn(async () => 0);
    Object.assign(h.migration.services, {
        replicator: { getActiveReplicator: () => ({ countCompromisedChunks: remoteCount }) },
    });
    Object.assign(h.migration.services.API, { isOnline: true });
    return { ...h, pouch, receipts, remoteCount };
}

describe("ModuleMigration local chunk safety receipts", () => {
    it("requires an actual full clean scan on upgrade and then skips unchanged historical Mango scans", async () => {
        const h = createChunkSafetyMigration();
        expect(await h.migration.hasCompromisedChunks()).toBe(true);
        expect(h.pouch.find).toHaveBeenCalledTimes(2);
        expect(h.receipts.has(COMPROMISED_CHUNK_SCAN_RECEIPT_KEY)).toBe(true);
        h.pouch.find.mockClear();
        expect(await h.migration.hasCompromisedChunks()).toBe(true);
        expect(h.pouch.find).not.toHaveBeenCalled();
        expect(h.remoteCount).toHaveBeenCalledTimes(2);
    });

    it("does not promote a historical Dismiss and doctor flag into a clean receipt", async () => {
        const h = createChunkSafetyMigration();
        h.pouch.find.mockResolvedValue({ docs: [{ _id: "legacy", type: "leaf" }] });
        expect(await h.migration.hasCompromisedChunks()).toBe(true);
        expect(h.askSelectStringDialogue).toHaveBeenCalledOnce();
        expect(h.receipts.has(COMPROMISED_CHUNK_SCAN_RECEIPT_KEY)).toBe(false);
    });

    it.each([REMOTE_COUCHDB, REMOTE_P2P])(
        "retains the existing full local and remote checks for %s",
        async (remoteType) => {
            const h = createChunkSafetyMigration(remoteType);
            await h.migration.hasCompromisedChunks();
            await h.migration.hasCompromisedChunks();
            expect(h.pouch.find).toHaveBeenCalledTimes(4);
            expect(h.remoteCount).toHaveBeenCalledTimes(2);
            expect(h.receipts.has(COMPROMISED_CHUNK_SCAN_RECEIPT_KEY)).toBe(false);
        }
    );
});

describe("ModuleMigration obsolete-setting migration", () => {
    it("persists the removal of an enabled automatic bulk chunk pre-send setting", async () => {
        const settings = { sendChunksBulk: true, sendChunksBulkMaxSize: 16 };
        const { migration, saveSettingData } = createMigration(noDocuments, settings);

        await migration.migrateDisableBulkSend();

        expect(settings).toEqual({ sendChunksBulk: false, sendChunksBulkMaxSize: 1 });
        expect(saveSettingData).toHaveBeenCalledOnce();
    });

    it("does not persist an already disabled automatic bulk chunk pre-send setting", async () => {
        const settings = { sendChunksBulk: false, sendChunksBulkMaxSize: 16 };
        const { migration, saveSettingData } = createMigration(noDocuments, settings);

        await migration.migrateDisableBulkSend();

        expect(settings).toEqual({ sendChunksBulk: false, sendChunksBulkMaxSize: 16 });
        expect(saveSettingData).not.toHaveBeenCalled();
    });
});

describe("ModuleMigration incomplete-document notice", () => {
    async function* oneDocument() {
        yield {
            _id: "Notes/example.md",
            _rev: "1-synthetic",
            path: "Notes/example.md",
            type: "plain",
            children: ["h:content"],
            size: 5,
            ctime: 1,
            mtime: 2,
        };
    }

    it.each(["suspended", "unloaded"])("does not start a content check while %s", async (state) => {
        const h = createMigration(oneDocument);
        if (state === "suspended") h.lifecycle.isSuspended.mockReturnValue(true);
        else h.lifecycle.hasUnloaded.mockReturnValue(true);

        await expect(h.migration.hasIncompleteDocs(state === "unloaded")).resolves.toBe(true);

        expect(h.kvGet).not.toHaveBeenCalled();
        expect(h.loadDocument).not.toHaveBeenCalled();
        expect(h.readStorage).not.toHaveBeenCalled();
        expect(h.kvSet).not.toHaveBeenCalled();
        expect(h.noticeGroups.setItem).not.toHaveBeenCalled();
    });

    it("checks matching sizes without reading the complete resident file", async () => {
        const h = createMigration(oneDocument);
        h.storageStat.mockResolvedValue({ type: "file", size: 5, ctime: 1, mtime: 2 });

        await expect(h.migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(h.loadDocument).toHaveBeenCalledOnce();
        expect(h.storageStat).toHaveBeenCalledWith("Notes/example.md");
        expect(h.readStorage).not.toHaveBeenCalled();
        expect(h.kvSet).toHaveBeenCalledWith("checkIncompleteDocs", true);
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("allows an explicitly forced check during paused synchronisation", async () => {
        const h = createMigration(oneDocument);
        h.lifecycle.isSuspended.mockReturnValue(true);
        h.storageStat.mockResolvedValue({ type: "file", size: 5, ctime: 1, mtime: 2 });

        await expect(h.migration.hasIncompleteDocs(true)).resolves.toBe(true);

        expect(h.loadDocument).toHaveBeenCalledOnce();
        expect(h.kvSet).toHaveBeenCalledExactlyOnceWith("checkIncompleteDocs", true);
    });

    it("shares an active check instead of starting a second full content scan", async () => {
        const h = createMigration(oneDocument);
        h.storageStat.mockResolvedValue({ type: "file", size: 5, ctime: 1, mtime: 2 });
        let release = () => {};
        const pending = new Promise<{ type: string; data: string[]; size: number }>((resolve) => {
            release = () => resolve({ type: "plain", data: ["hello"], size: 5 });
        });
        h.loadDocument.mockReturnValueOnce(pending);
        const first = h.migration.hasIncompleteDocs();
        const second = h.migration.hasIncompleteDocs(true);
        expect(second).toBe(first);
        await vi.waitFor(() => expect(h.loadDocument).toHaveBeenCalledOnce());
        release();

        await expect(first).resolves.toBe(true);
        expect(h.kvSet).toHaveBeenCalledExactlyOnceWith("checkIncompleteDocs", true);
    });

    it("waits for an in-flight check to stop without saving a completion marker", async () => {
        const h = createMigration(oneDocument);
        let release = () => {};
        const pending = new Promise<{ type: string; data: string[]; size: number }>((resolve) => {
            release = () => resolve({ type: "plain", data: ["hello"], size: 5 });
        });
        h.loadDocument.mockReturnValueOnce(pending);
        const check = h.migration.hasIncompleteDocs();
        await vi.waitFor(() => expect(h.loadDocument).toHaveBeenCalledOnce());
        const stopped = h.migration["stopIncompleteDocumentCheck"]();
        release();

        await expect(stopped).resolves.toBe(true);
        await expect(check).resolves.toBe(true);
        expect(h.storageStat).not.toHaveBeenCalled();
        expect(h.readStorage).not.toHaveBeenCalled();
        expect(h.kvSet).not.toHaveBeenCalled();
        expect(h.noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
        h.storageStat.mockResolvedValue({ type: "file", size: 5, ctime: 1, mtime: 2 });
        await expect(h.migration.hasIncompleteDocs()).resolves.toBe(true);
        expect(h.loadDocument).toHaveBeenCalledTimes(2);
        expect(h.kvSet).toHaveBeenCalledExactlyOnceWith("checkIncompleteDocs", true);
    });

    it("rechecks a stat mismatch against actual bytes before reporting a problem", async () => {
        const h = createMigration(oneDocument);
        h.readStorage.mockResolvedValue(new TextEncoder().encode("hello"));

        await expect(h.migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(h.readStorage).toHaveBeenCalledWith("Notes/example.md");
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
        expect(h.kvSet).toHaveBeenCalledWith("checkIncompleteDocs", true);
    });

    it("stops after suspension during a database read without marking the check complete", async () => {
        const h = createMigration(oneDocument);
        h.loadDocument.mockImplementationOnce(async (entry) => {
            h.lifecycle.isSuspended.mockReturnValue(true);
            return { type: "plain", data: ["hello"], size: entry.size };
        });

        await expect(h.migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(h.storageStat).not.toHaveBeenCalled();
        expect(h.readStorage).not.toHaveBeenCalled();
        expect(h.kvSet).not.toHaveBeenCalled();
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
        expect(h.noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
    });

    it("does not show a repair dialogue after unloading during a resident read", async () => {
        const h = createMigration(oneDocument);
        h.readStorage.mockImplementationOnce(async () => {
            h.lifecycle.hasUnloaded.mockReturnValue(true);
            return new Uint8Array(4);
        });

        await expect(h.migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
        expect(h.kvSet).not.toHaveBeenCalled();
        expect(h.noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
    });

    it("does not block suspension on a repair decision or act on its later answer", async () => {
        const h = createMigration(oneDocument);
        let close = () => {};
        h.askSelectStringDialogue.mockImplementationOnce(
            (_message, buttons) =>
                new Promise<string | undefined>((resolve) => {
                    close = () => resolve(buttons[buttons.length - 1]);
                })
        );
        const check = h.migration.hasIncompleteDocs();
        await vi.waitFor(() => expect(h.askSelectStringDialogue).toHaveBeenCalledOnce());

        await expect(h.migration["stopIncompleteDocumentCheck"]()).resolves.toBe(true);
        close();
        await expect(check).resolves.toBe(true);
        expect(h.kvSet).not.toHaveBeenCalled();
        expect(h.noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
    });

    it("does not offer the destructive-looking Fix action when every mismatch is conflicted", async () => {
        async function* conflictedDocument() {
            yield {
                _id: "Todo/Torsdag.md",
                _rev: "2-conflicted",
                _conflicts: ["2-other"],
                path: "Todo/Torsdag.md",
                type: "plain",
                children: ["h:content"],
                size: 5,
                ctime: 1,
                mtime: 2,
            };
        }
        const { migration, askSelectStringDialogue } = createMigration(conflictedDocument);

        await expect(migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(askSelectStringDialogue).toHaveBeenCalledOnce();
        expect(askSelectStringDialogue.mock.calls[0][1]).toHaveLength(2);
    });

    it("waits for initial replication before the one-time document check", async () => {
        const events: string[] = [];
        async function* documentsAfterReplication() {
            events.push("incomplete-documents");
        }
        const { migration, replicateByEvent } = createMigration(documentsAfterReplication);
        replicateByEvent.mockImplementation(async () => {
            events.push("replication");
            return true;
        });

        await expect(migration.checkIncompleteDocsAfterInitialReplication()).resolves.toBe(true);

        expect(events).toEqual(["replication", "incomplete-documents"]);
    });

    it("does not request another replication after the document check has already completed", async () => {
        const { migration, noticeGroups, replicateByEvent, kvGet } = createMigration();
        kvGet.mockResolvedValue(true);

        await expect(migration.checkIncompleteDocsAfterInitialReplication()).resolves.toBe(true);

        expect(replicateByEvent).not.toHaveBeenCalled();
        expect(noticeGroups.setItem).not.toHaveBeenCalled();
    });

    it("defers the content audit when the initial replication does not complete", async () => {
        const { migration, noticeGroups, replicateByEvent } = createMigration();
        replicateByEvent.mockResolvedValue(false);

        await expect(migration.checkIncompleteDocsAfterInitialReplication()).resolves.toBe(true);

        expect(replicateByEvent).toHaveBeenCalledOnce();
        expect(noticeGroups.setItem).not.toHaveBeenCalled();
    });

    it("keeps the check and its result in one persistent named group", async () => {
        const { migration, noticeGroups } = createMigration();

        await expect(migration.hasIncompleteDocs()).resolves.toBe(true);

        expect(noticeGroups.setItem).toHaveBeenNthCalledWith(1, "startup-integrity-check", "checking", {
            message: "Checking for incomplete documents...",
        });
        expect(noticeGroups.setItem).toHaveBeenNthCalledWith(2, "startup-integrity-check", "result", {
            message: "No size mismatches found",
        });
        expect(noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
    });

    it("finishes the group with a failure result when the scan throws", async () => {
        const { migration, noticeGroups } = createMigration(failedDocumentScan);

        await expect(migration.hasIncompleteDocs()).rejects.toThrow("scan failed");

        expect(noticeGroups.setItem).toHaveBeenLastCalledWith("startup-integrity-check", "result", {
            message: "The incomplete document check could not be completed.",
        });
        expect(noticeGroups.finish).toHaveBeenCalledWith("startup-integrity-check");
    });
});
