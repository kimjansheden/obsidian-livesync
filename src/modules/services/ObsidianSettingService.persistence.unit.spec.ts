import { DEFAULT_SETTINGS, type ObsidianLiveSyncSettings } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { IAPIService } from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import {
    SettingService,
    type SettingServiceDependencies,
} from "@vrtmrz/livesync-commonlib/compat/services/base/SettingService";
import { ServiceContext } from "@vrtmrz/livesync-commonlib/context";
import { describe, expect, it, vi } from "vitest";
import { prepareSettingsForPersistence } from "@/common/security/settingsPersistence";

class PersistenceProbe extends SettingService<ServiceContext> {
    persisted?: ObsidianLiveSyncSettings;

    protected setItem(_key: string, _value: string): void {}
    protected getItem(_key: string): string {
        return "";
    }
    protected deleteItem(_key: string): void {}

    protected saveData(settings: ObsidianLiveSyncSettings): Promise<void> {
        this.persisted = prepareSettingsForPersistence(settings);
        return Promise.resolve();
    }

    protected loadData(): Promise<ObsidianLiveSyncSettings | undefined> {
        return Promise.resolve(this.persisted);
    }
}

function createProbe(): PersistenceProbe {
    const api = {
        getSystemVaultName: vi.fn(() => "synthetic-vault"),
        getAppID: vi.fn(() => "synthetic-app"),
        confirm: {
            askString: vi.fn(() => Promise.resolve("")),
        },
        addLog: vi.fn(),
    } as unknown as IAPIService;
    const dependencies: SettingServiceDependencies = { APIService: api };
    return new PersistenceProbe(new ServiceContext(), dependencies);
}

describe("Object Storage settings persistence", () => {
    it("encrypts, scrubs, and restores a pure S3 profile across a host persistence boundary", async () => {
        const service = createProbe();
        service.settings = {
            ...DEFAULT_SETTINGS,
            accessKey: "SYNTHETICACCESSKEY",
            secretKey: "synthetic-secret-key",
            bucket: "synthetic-bucket",
            endpoint: "https://storage.example.invalid",
            region: "auto",
            forcePathStyle: true,
        };

        await service.saveSettingData();

        const persisted = service.persisted;
        if (!persisted) throw new Error("The persistence boundary did not receive settings");
        expect(persisted?.encryptedCouchDBConnection).toMatch(/^%/u);
        expect(persisted?.accessKey).toBe("");
        expect(persisted?.secretKey).toBe("");
        expect(persisted?.bucket).toBe("");
        expect(persisted?.endpoint).toBe("");
        expect(service.currentSettings().accessKey).toBe("SYNTHETICACCESSKEY");

        const restarted = createProbe();
        const restored = await restarted.decryptSettings(structuredClone(persisted));
        expect(restored.accessKey).toBe("SYNTHETICACCESSKEY");
        expect(restored.secretKey).toBe("synthetic-secret-key");
        expect(restored.bucket).toBe("synthetic-bucket");
        expect(restored.endpoint).toBe("https://storage.example.invalid");
        expect(restored.region).toBe("auto");
        expect(restored.forcePathStyle).toBe(true);
    });
});
