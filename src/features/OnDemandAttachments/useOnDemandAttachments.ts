import { MarkdownRenderChild, MarkdownRenderer, Notice, Platform, type MarkdownView, type Plugin } from "obsidian";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { LiveSyncJournalReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/journal/LiveSyncJournalReplicator";
import type { FilePath, FilePathWithPrefix, MetaEntry } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { readAsBlob } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { LiveSyncCore } from "@/main";
import { ServiceFileHandler } from "@/serviceModules/FileHandler";
import { createFileReflectionProvenance } from "@/serviceModules/FileReflectionProvenance";
import {
    AttachmentCache,
    MAX_CACHED_ATTACHMENT_BYTES,
    canCacheAttachment,
    type AttachmentCacheRecord,
} from "./AttachmentCache";
import { MobileAttachmentCacheIO, sha256Buffer } from "./MobileAttachmentCacheIO";
import { DeferredAttachmentLinks } from "./attachmentLink";
import { waitForAttachmentReadiness } from "./attachmentReadiness";
import { AttachmentBatch, type AttachmentBatchResult } from "./AttachmentBatch";
import { AttachmentRegistry } from "./AttachmentRegistry";
import { prepareAttachmentOffload, selectAttachmentTargets } from "./AttachmentPreparation";
import {
    MobileMetadataCache,
    MOBILE_METADATA_CACHE_FAILURE,
} from "@/serviceFeatures/metadataCache/MobileMetadataCache";

export const ATTACHMENT_CACHE_MIN_RELEASE = 22;

function bootstrapFloor(plugin: Plugin): number {
    const registry: unknown = Reflect.get(plugin.app, "plugins");
    const instances: unknown = registry && typeof registry === "object" ? Reflect.get(registry, "plugins") : undefined;
    const facade: unknown =
        instances && typeof instances === "object" ? Reflect.get(instances, plugin.manifest.id) : undefined;
    const floor: unknown =
        facade && typeof facade === "object" ? Reflect.get(facade, "minimumRuntimeReleaseNumber") : undefined;
    return typeof floor === "number" && Number.isSafeInteger(floor) ? floor : 0;
}

/** Android materialisation policy. Each deferred path remains in the local synchronisation database. */
export class OnDemandAttachments {
    cache?: AttachmentCache;
    private readonly links = new DeferredAttachmentLinks([]);
    private disposed = false;
    private failureNotice?: Notice;
    private batch?: Promise<AttachmentBatchResult>;
    private batchControl?: AttachmentBatch;
    private preparingReplicator?: LiveSyncJournalReplicator;
    private migrationPrepared = false;
    private preparedRemote?: string;
    private preparedTargets?: ReadonlySet<string>;
    private preparationNotice?: Notice;
    private recoveryIO?: MobileAttachmentCacheIO;
    private recovering = false;
    recoveryRequired = false;

    constructor(
        private readonly plugin: Plugin,
        private readonly core: LiveSyncCore
    ) {
        const s = core.services;
        new MobileMetadataCache(plugin.app).install(
            (cleanup) => plugin.register(cleanup),
            () => new Notice(MOBILE_METADATA_CACHE_FAILURE)
        );
        plugin.register(() => {
            this.disposed = true;
            this.batchControl?.stop();
            this.preparationNotice?.hide();
            this.failureNotice?.hide();
        });
        s.vault.isTargetFile.addHandler(
            (file) =>
                Promise.resolve(
                    !this.recoveryRequired && !this.cache?.isDeferred(typeof file === "string" ? file : file.path)
                ),
            -1000
        );
        s.setting.onSettingRealised.addHandler(() => {
            this.batchControl?.stop();
            return Promise.resolve(true);
        });
        s.appLifecycle.onUnload.addHandler(async () => {
            await this.stopOffloading();
            await this.recoveryIO?.waitForRecoveryMetadata();
            return true;
        });
        s.appLifecycle.onSettingLoaded.addHandler(async () => {
            try {
                await this.initialise();
                return true;
            } catch {
                this.recoveryRequired = true;
                s.appLifecycle.setSuspended(true);
                new Notice(
                    "The attachment cache could not be opened. Synchronisation is paused to preserve its originals.",
                    0
                );
                return false;
            }
        }, 100);
        s.appLifecycle.onLayoutReady.addHandler(() => {
            this.installViewHooks();
            return Promise.resolve(true);
        });
        plugin.addCommand({
            id: "recover-attachment-originals",
            name: "Recover preserved attachment originals",
            callback: () => {
                void this.recoverOriginals().catch(() => this.reportFailure());
            },
        });
        plugin.addCommand({
            id: "cache-older-attachments",
            name: "Use older attachments on demand",
            callback: () => {
                void this.dehydrateOlder().catch(() => this.reportFailure());
            },
        });
        plugin.addCommand({
            id: "stop-preparing-attachments",
            name: "Stop preparing attachments",
            callback: () => {
                void this.stopOffloading().catch(() => this.reportFailure());
            },
        });
        plugin.addCommand({
            id: "restore-cached-attachments",
            name: "Make cached attachments available offline",
            callback: () => {
                void this.restoreAll().catch(() => this.reportFailure());
            },
        });
    }

    private reportFailure(): void {
        if (this.disposed) return;
        const message =
            "Some attachments could not be made available. Original copies are kept; open the attachment again to retry.";
        if (this.failureNotice) this.failureNotice.setMessage(message);
        else this.failureNotice = new Notice(message, 0);
    }

    private replicator(): LiveSyncJournalReplicator {
        const replicator = this.core.services.replicator.getActiveReplicator();
        if (!(replicator instanceof LiveSyncJournalReplicator))
            throw new Error("On-demand attachments require R2 journal synchronisation");
        return replicator;
    }

    private async initialise(): Promise<void> {
        const s = this.core.services;
        const active = s.keyValueDB.openSimpleStore<AttachmentCacheRecord>("on-demand-attachments-v1");
        let io: MobileAttachmentCacheIO;
        try {
            io = await MobileAttachmentCacheIO.create(
                this.plugin.app,
                () => !this.disposed && !s.appLifecycle.hasUnloaded()
            );
        } catch (error) {
            // Unsupported adapters keep their existing behaviour unless they already own deferred originals.
            if ((await active.keys("", "\uffff")).length === 0) return;
            throw error;
        }
        this.recoveryIO = io;
        const registry = new AttachmentRegistry(
            {
                keys: () => active.keys("", "\uffff"),
                get: (key) => active.get(key),
                set: (key, record) => active.set(key, record),
                delete: (key) => active.delete(key),
            },
            io
        );
        await registry.load();
        const descriptors = s.keyValueDB.openSimpleStore<MetaEntry>("on-demand-attachment-descriptors-v1");
        const provenance = createFileReflectionProvenance(s.keyValueDB);
        const handler = this.core.serviceModules.fileHandler;
        if (!(handler instanceof ServiceFileHandler))
            throw new Error("The file handler does not support on-demand attachments");
        const cache = new AttachmentCache({
            store: registry,
            io,
            hash: sha256Buffer,
            newKey: () =>
                [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join(""),
            withPathLock: async (path, task) =>
                await serialized(`processFileEvent-${await s.path.path2id(path as FilePathWithPrefix)}`, task),
            revision: async (path, hash, stat) => {
                if (!this.preparedTargets?.has(path)) return undefined;
                const record = await provenance.get(path as FilePathWithPrefix);
                if (record?.pendingPublication || record?.incompleteWriteRevision)
                    throw new Error("An attachment write has not finished");
                const db = this.core.serviceModules.databaseFileAccess;
                const target = path as FilePathWithPrefix;
                // The target policy was checked before native moves began; retain the exact revision checks here.
                const meta = await db.fetchEntryMeta(target, record?.revision, false);
                if (
                    !meta ||
                    !meta._rev ||
                    meta.deleted ||
                    meta._deleted ||
                    meta.size !== stat.size ||
                    s.path.getPath(meta) !== path
                )
                    return undefined;
                const content = await db.fetchEntryFromMeta(meta, true, false);
                if (!content || (await sha256Buffer(await readAsBlob(content).arrayBuffer())) !== hash)
                    return undefined;
                if (this.disposed || s.appLifecycle.hasUnloaded()) throw new Error("Attachment preparation stopped");
                // Keep the immutable chunk description even after local revision compaction.
                await descriptors.set(`${path}:${meta._rev}`, meta);
                return meta._rev;
            },
            recover: async (record) => {
                const meta = await descriptors.get(`${record.path}:${record.revision}`);
                if (
                    !meta ||
                    meta._rev !== record.revision ||
                    meta.deleted ||
                    meta._deleted ||
                    s.path.getPath(meta) !== record.path
                )
                    return false;
                return await this.replicator().fetchRemoteFile(meta, MAX_CACHED_ATTACHMENT_BYTES);
            },
            afterRestore: async (path) => {
                const target = path as FilePathWithPrefix;
                if (await handler.prepareOfflinePath(target, false, true))
                    await handler.dbToStorage(target, path as FilePath);
            },
            mayRun: () => !this.disposed && !s.appLifecycle.hasUnloaded(),
            now: Date.now,
            selectionChanged: (path, deferred) => (deferred ? this.links.add(path) : this.links.remove(path)),
        });
        await cache.load();
        if (this.disposed || s.appLifecycle.hasUnloaded()) throw new Error("Attachment cache initialisation stopped");
        this.cache = cache;
        handler.attachmentCache = cache;
        const state = s.keyValueDB.openSimpleStore<{ needsStatusTrim: boolean }>("on-demand-attachment-config-v1");
        if ((await state.get("migration"))?.needsStatusTrim) {
            const map = await s.keyValueDB.kvDB.get<Record<string, number> | undefined>("fileStatusMap");
            if (map && typeof map === "object" && !Array.isArray(map)) {
                if (this.disposed || s.appLifecycle.hasUnloaded())
                    throw new Error("Attachment cache initialisation stopped");
                await s.keyValueDB.kvDB.set(
                    "fileStatusMap",
                    Object.fromEntries(Object.entries(map).filter(([path]) => !cache.isDeferred(path)))
                );
            }
            await state.set("migration", { needsStatusTrim: false });
        }
    }

    get isPreparing(): boolean {
        return this.batch !== undefined;
    }

    async recoverOriginals(): Promise<void> {
        const io = this.recoveryIO,
            s = this.core.services;
        if (!io || this.recovering || this.batch || this.disposed)
            throw new Error("Attachment recovery is unavailable");
        this.recovering = true;
        s.appLifecycle.setSuspended(true);
        const notice = new Notice("Recovering preserved attachment originals…", 0);
        try {
            if (!(await s.appLifecycle.onSuspending())) throw new Error("Synchronisation could not be paused");
            for (const record of await io.recoveryRecords()) {
                if (this.disposed) throw new Error("Attachment recovery stopped");
                const body = await io.cacheStat(record.key);
                const source = await io.sourceStat(record.path);
                if (!body) {
                    if (!source) throw new Error("An attachment original needs remote recovery");
                    continue;
                }
                const bytes = await io.cacheRead(record.key);
                if (bytes.byteLength !== record.stat.size || (await sha256Buffer(bytes)) !== record.hash)
                    throw new Error("A preserved original failed its integrity check");
                if (
                    source &&
                    source.size === record.stat.size &&
                    (await sha256Buffer(await io.sourceRead(record.path))) === record.hash
                )
                    continue;
                const dot = record.path.lastIndexOf(".");
                const target = source
                    ? `${record.path.slice(0, dot)}.recovered-${record.key}${record.path.slice(dot)}`
                    : record.path;
                const existing = await io.sourceStat(target);
                if (existing) {
                    if (
                        existing.size !== record.stat.size ||
                        (await sha256Buffer(await io.sourceRead(target))) !== record.hash
                    )
                        throw new Error("An attachment recovery copy already exists with different content");
                    continue;
                }
                await io.moveToVault(record.key, target, record.stat);
                if ((await sha256Buffer(await io.sourceRead(target))) !== record.hash)
                    throw new Error("A recovered attachment failed verification");
                await io.archiveRecoveryRecord(record, target);
            }
            const active = s.keyValueDB.openSimpleStore<AttachmentCacheRecord>("on-demand-attachments-v1");
            for (const key of await active.keys("", "\uffff")) await active.delete(key);
            await io.writeRegistryFingerprint("0".repeat(64));
            notice.setMessage("Attachment originals recovered. Restart Obsidian before resuming synchronisation.");
        } catch (error) {
            notice.setMessage("Attachment recovery stopped. Original copies are kept; synchronisation remains paused.");
            throw error;
        } finally {
            this.recovering = false;
        }
    }

    async stopOffloading(): Promise<void> {
        const running = this.batch;
        if (!running) return;
        this.batchControl?.stop();
        this.preparingReplicator?.closeReplication();
        await running;
    }

    dehydrateOlder(): Promise<AttachmentBatchResult> {
        if (this.batch) return this.batch;
        const control = new AttachmentBatch();
        this.batchControl = control;
        const operation = this.runDehydrate(control);
        this.batch = operation;
        void operation
            .finally(() => {
                this.batch = undefined;
                this.batchControl = undefined;
                this.preparedTargets = undefined;
            })
            .catch(() => {});
        return operation;
    }

    private async runDehydrate(control: AttachmentBatch): Promise<AttachmentBatchResult> {
        const s = this.core.services,
            cache = this.cache;
        if (!cache || !s.appLifecycle.isReady() || this.disposed)
            throw new Error("On-demand attachments are not ready");
        if (bootstrapFloor(this.plugin) < ATTACHMENT_CACHE_MIN_RELEASE)
            throw new Error(
                "Update the bootstrap and remove incompatible recovery runtimes before offloading attachments"
            );
        this.preparationNotice?.hide();
        const notice = (this.preparationNotice = new Notice("Preparing older attachments for on-demand access…", 0));
        let restoreFileEvents: (() => void) | undefined;
        try {
            if (!this.migrationPrepared) {
                this.preparingReplicator = this.replicator();
                const replicator = this.preparingReplicator,
                    remote = replicator.client.getRemoteKey();
                try {
                    const prepared = await prepareAttachmentOffload({
                        remoteKey: () => replicator.client.getRemoteKey(),
                        publish: () => replicator.replicateAllToServer(s.setting.currentSettings(), true),
                        isStopped: () => control.isStopped,
                        recordPreparation: () =>
                            s.keyValueDB
                                .openSimpleStore<{ needsStatusTrim: boolean }>("on-demand-attachment-config-v1")
                                .set("migration", { needsStatusTrim: true }),
                        suspend: () => {
                            s.appLifecycle.setSuspended(true);
                            return s.appLifecycle.onSuspending();
                        },
                    });
                    if (!prepared) return { moved: 0, retained: 0, stopped: true };
                    this.preparedRemote = remote;
                    this.migrationPrepared = true;
                } finally {
                    this.preparingReplicator = undefined;
                }
            }
            const files = this.plugin.app.vault
                .getFiles()
                .filter((file) => !cache.isDeferred(file.path) && canCacheAttachment(file.path, file.stat, Date.now()));
            const targets = await selectAttachmentTargets(
                files.map((file) => file.path),
                {
                    isTarget: (path) => s.vault.isTargetFile(path),
                    isStopped: () => control.isStopped,
                    mayRun: () => !this.disposed && !s.appLifecycle.hasUnloaded(),
                    progress: async (checked) => {
                        notice.setMessage(`Checking attachment targets: ${checked}/${files.length}`);
                        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                    },
                }
            );
            if (!targets) return { moved: 0, retained: 0, stopped: true };
            this.preparedTargets = new Set(targets);
            if (!this.recoveryIO) throw new Error("The Android attachment IO is unavailable");
            restoreFileEvents = await this.recoveryIO.deferRetiredFileEvents((path) => cache.isDeferred(path));
            const result = await control.run(
                targets,
                (path) => {
                    if (this.replicator().client.getRemoteKey() !== this.preparedRemote)
                        throw new Error("The remote changed after attachment preparation");
                    return cache.dehydrate(path);
                },
                () => !this.disposed && !s.appLifecycle.hasUnloaded(),
                async (processed) => {
                    notice.setMessage(`Preparing attachments: ${processed}/${files.length}`);
                    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                },
                4
            );
            result.retained += files.length - targets.length;
            if (!this.disposed)
                notice.setMessage(
                    result.stopped
                        ? "Preparation stopped. Original copies are kept. Run preparation again to continue, or restart Obsidian."
                        : "Attachments are prepared. Restart Obsidian to finish updating the local file cache."
                );
            return result;
        } catch (error) {
            if (control.isStopped && !this.migrationPrepared) {
                if (!this.disposed) notice.setMessage("Preparation stopped. Original copies are kept.");
                return { moved: 0, retained: 0, stopped: true };
            }
            if (!this.disposed)
                notice.setMessage(
                    "Attachment offloading stopped. Original copies are kept. Restart Obsidian before resuming synchronisation."
                );
            throw error;
        } finally {
            restoreFileEvents?.();
        }
    }

    async restoreAll(): Promise<void> {
        const cache = this.cache;
        if (!cache) throw new Error("The attachment cache is unavailable");
        for (const path of cache.paths) await cache.hydrate(path);
    }

    private sourcePath(node: Element): string | null {
        for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view as MarkdownView;
            if (view.containerEl.contains(node)) return view.file?.path ?? null;
        }
        return null;
    }

    private async waitUntilReady(): Promise<void> {
        const lifecycle = this.core.services.appLifecycle;
        await waitForAttachmentReadiness(
            () => lifecycle.isReady(),
            () => !this.disposed && !lifecycle.hasUnloaded(),
            () => new Promise<void>((resolve) => window.setTimeout(resolve, 100))
        );
    }

    private installViewHooks(): void {
        const cache = this.cache;
        if (!cache || this.disposed) return;
        const { app } = this.plugin;
        const root = app.vault.adapter.getResourcePath("").split("?")[0];
        const resourceRoot = root.endsWith("/") ? root : `${root}/`;
        const resolve = (target: string, source: string) =>
            this.links.resolve(
                target.startsWith(resourceRoot) ? target.slice(resourceRoot.length) : target,
                source,
                target.startsWith(resourceRoot),
                app.metadataCache.getFirstLinkpathDest(target, source)?.path
            );
        const pending = new Map<HTMLElement, { path: string; source: string; raw: string; image: boolean }>();
        const seen = new WeakMap<HTMLElement, string>();
        const children = new Map<HTMLElement, MarkdownRenderChild>();
        const semaphore = Semaphore(2);
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const node = entry.target as HTMLElement,
                        item = pending.get(node);
                    if (!item) continue;
                    observer.unobserve(node);
                    pending.delete(node);
                    void (async () => {
                        const release = await semaphore.acquire();
                        try {
                            await this.waitUntilReady();
                            if (this.disposed) return;
                            await cache.hydrate(item.path);
                            if (!node.isConnected || this.disposed) return;
                            const file = app.vault.getFileByPath(item.path);
                            if (!file) return;
                            if (item.image) node.setAttribute("src", app.vault.getResourcePath(file));
                            else {
                                node.empty();
                                const child = new MarkdownRenderChild(node);
                                this.plugin.addChild(child);
                                children.set(node, child);
                                const link = app.fileManager.generateMarkdownLink(file, item.source);
                                await MarkdownRenderer.render(app, `!${link}`, node, item.source, child);
                            }
                        } catch {
                            this.reportFailure();
                        } finally {
                            release();
                        }
                    })();
                }
            },
            { rootMargin: "250px" }
        );
        let scheduled = false;
        const scan = () => {
            scheduled = false;
            if (this.disposed) return;
            for (const [node] of pending)
                if (!node.isConnected) {
                    observer.unobserve(node);
                    pending.delete(node);
                }
            for (const [node, child] of children)
                if (!node.isConnected) {
                    this.plugin.removeChild(child);
                    children.delete(node);
                }
            for (const leaf of app.workspace.getLeavesOfType("markdown")) {
                const view = leaf.view as MarkdownView;
                const source = view.file?.path;
                if (!source) continue;
                for (const node of Array.from(
                    view.containerEl.querySelectorAll<HTMLElement>(".internal-embed[src], img[src]")
                )) {
                    const raw = node.getAttribute("src") ?? "";
                    const path = resolve(raw, source);
                    if (!path || !cache.isDeferred(path) || seen.get(node) === path) continue;
                    seen.set(node, path);
                    pending.set(node, { path, source, raw, image: node.tagName === "IMG" });
                    observer.observe(node);
                }
            }
        };
        const changes = new MutationObserver(() => {
            if (!scheduled) {
                scheduled = true;
                queueMicrotask(scan);
            }
        });
        changes.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "data-href"],
        });
        this.plugin.register(() => {
            changes.disconnect();
            observer.disconnect();
            pending.clear();
            for (const child of children.values()) this.plugin.removeChild(child);
            children.clear();
        });
        this.plugin.registerDomEvent(
            document,
            "click",
            (event: MouseEvent) => {
                const target =
                    event.target instanceof Element ? event.target.closest(".internal-link, .internal-embed") : null;
                if (!target) return;
                const source = this.sourcePath(target);
                const raw =
                    target.getAttribute("data-href") ?? target.getAttribute("src") ?? target.getAttribute("href");
                const path = raw && source !== null ? resolve(raw, source) : null;
                if (!path || !cache.isDeferred(path)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                void (async () => {
                    await this.waitUntilReady();
                    if (this.disposed) return;
                    await cache.hydrate(path);
                })()
                    .then(async () => {
                        const file = app.vault.getFileByPath(path);
                        if (file && !this.disposed) await app.workspace.getLeaf(false).openFile(file);
                    })
                    .catch(() => this.reportFailure());
            },
            true
        );
        scan();
    }
}

export function useOnDemandAttachments(plugin: Plugin, core: LiveSyncCore): OnDemandAttachments | undefined {
    return Platform.isAndroidApp ? new OnDemandAttachments(plugin, core) : undefined;
}
