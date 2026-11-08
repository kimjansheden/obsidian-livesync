import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceFileHandlerBase } from "@vrtmrz/livesync-commonlib/compat/serviceModules/ServiceFileHandlerBase";
import { ServiceFileHandler } from "./FileHandler";
import type { FilePath, FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";

afterEach(() => vi.restoreAllMocks());
describe("deferred physical attachments", () => {
    it("does not turn physical offloading into a deletion or a background download", async () => {
        const handler = Object.create(ServiceFileHandler.prototype) as ServiceFileHandler;
        handler.attachmentCache = { isDeferred: (path: string) => path === "Archive/a.png" };
        const remove = vi.spyOn(ServiceFileHandlerBase.prototype, "deleteFileFromDB").mockResolvedValue(true);
        const reflect = vi.spyOn(ServiceFileHandlerBase.prototype, "dbToStorage").mockResolvedValue(true);
        const prepare = vi.spyOn(ServiceFileHandlerBase.prototype, "prepareOfflinePath").mockResolvedValue(true);
        const target = "Archive/a.png" as FilePathWithPrefix;
        expect(await handler.deleteFileFromDB(target as unknown as FilePath)).toBe(true);
        expect(await handler.dbToStorage(target, target as unknown as FilePath)).toBe(true);
        expect(await handler.prepareOfflinePath(target, false)).toBe(true);
        expect(remove).not.toHaveBeenCalled();
        expect(reflect).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        const note = "Notes/example.md" as FilePathWithPrefix;
        await handler.deleteFileFromDB(note as unknown as FilePath);
        await handler.dbToStorage(note, note as unknown as FilePath);
        await handler.prepareOfflinePath(note, false);
        expect(remove).toHaveBeenCalledWith(note);
        expect(reflect).toHaveBeenCalledWith(note, note);
        expect(prepare).toHaveBeenCalledWith(note, false);
    });
});
