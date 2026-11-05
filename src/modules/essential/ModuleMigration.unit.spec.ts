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
        setting: { saveSettingData: vi.fn(async () => undefined) },
        replication: { replicateByEvent: vi.fn(async () => true) },
        vault: { isTargetFile: vi.fn(async () => true) },
        path: { getPath: vi.fn((entry: { path: string }) => entry.path) },
    };
    const askSelectStringDialogue = vi.fn(
        async (_message: string, _buttons: string[], _options: unknown): Promise<undefined> => undefined
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
        storageAccess: { readHiddenFileBinary: vi.fn(async () => new Uint8Array(4)) },
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
