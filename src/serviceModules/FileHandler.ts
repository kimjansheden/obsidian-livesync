import { ServiceFileHandlerBase } from "@vrtmrz/livesync-commonlib/compat/serviceModules/ServiceFileHandlerBase";
import type { AttachmentCache } from "@/features/OnDemandAttachments/AttachmentCache";

// markChangesAreSame uses persistent data implicitly, we should refactor it too.
// also, compareFileFreshness depends on marked changes, so we should refactor it as well. For now, to make the refactoring done once, we just use them directly.
// Hence it remains in the plug-in rather than Commonlib. (markChangesAreSame is using indexedDB).
// Refactored: markChangesAreSame, unmarkChanges, compareFileFreshness, isMarkedAsSameChanges are now moved to PathService
export class ServiceFileHandler extends ServiceFileHandlerBase {
    attachmentCache?: Pick<AttachmentCache, "isDeferred">;

    override async canPrepareOfflinePath(...args: Parameters<ServiceFileHandlerBase["canPrepareOfflinePath"]>) {
        if (this.attachmentCache?.isDeferred(args[0])) return true;
        return await super.canPrepareOfflinePath(...args);
    }

    override async prepareOfflinePath(...args: Parameters<ServiceFileHandlerBase["prepareOfflinePath"]>) {
        if (this.attachmentCache?.isDeferred(args[0])) return true;
        return await super.prepareOfflinePath(...args);
    }

    override async deleteFileFromDB(...args: Parameters<ServiceFileHandlerBase["deleteFileFromDB"]>) {
        const path = typeof args[0] === "string" ? args[0] : args[0].path;
        if (this.attachmentCache?.isDeferred(path)) return true;
        return await super.deleteFileFromDB(...args);
    }

    override async dbToStorage(...args: Parameters<ServiceFileHandlerBase["dbToStorage"]>) {
        const path = typeof args[0] === "string" ? args[0] : this.getPath(args[0]);
        if (this.attachmentCache?.isDeferred(path)) return true;
        return await super.dbToStorage(...args);
    }

    override async dbToStorageWithSpecificRev(
        ...args: Parameters<ServiceFileHandlerBase["dbToStorageWithSpecificRev"]>
    ) {
        const path = typeof args[0] === "string" ? args[0] : args[0]?.path;
        if (path && this.attachmentCache?.isDeferred(path)) return false;
        return await super.dbToStorageWithSpecificRev(...args);
    }
}
