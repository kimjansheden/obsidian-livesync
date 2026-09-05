import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ObsidianStorageAdapter } from "./ObsidianStorageAdapter";

describe("ObsidianStorageAdapter", () => {
    it("rejects unsafe paths before they reach the Obsidian storage adapter", async () => {
        const exists = vi.fn().mockResolvedValue(false);
        const stat = vi.fn().mockResolvedValue(null);
        const mkdir = vi.fn().mockResolvedValue(undefined);
        const remove = vi.fn().mockResolvedValue(undefined);
        const read = vi.fn().mockResolvedValue("");
        const readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(0));
        const write = vi.fn().mockResolvedValue(undefined);
        const writeBinary = vi.fn().mockResolvedValue(undefined);
        const append = vi.fn().mockResolvedValue(undefined);
        const list = vi.fn().mockResolvedValue({ files: [], folders: [] });
        const app = {
            vault: {
                adapter: { exists, stat, mkdir, remove, read, readBinary, write, writeBinary, append, list },
            },
        } as unknown as App;
        const adapter = new ObsidianStorageAdapter(app);

        for (const path of ["../outside", "nested/../outside", "/absolute", "C:/absolute", "nested\\outside"]) {
            await expect(adapter.exists(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.trystat(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.stat(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.mkdir(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.remove(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.read(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.readBinary(path)).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.write(path, "content")).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.writeBinary(path, new ArrayBuffer(0))).rejects.toThrow("unsafe vault-relative path");
            await expect(adapter.append(path, "content")).rejects.toThrow("unsafe vault-relative path");
            expect(() => adapter.list(path)).toThrow("unsafe vault-relative path");
        }

        await expect(adapter.remove("")).rejects.toThrow("unsafe vault-relative path");
        await expect(adapter.write("", "content")).rejects.toThrow("unsafe vault-relative path");
        await expect(adapter.read("")).rejects.toThrow("unsafe vault-relative path");

        expect(exists).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
        expect(mkdir).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(readBinary).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(writeBinary).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
    });

    it("allows root-safe operations while refusing root data mutation", async () => {
        const exists = vi.fn().mockResolvedValue(true);
        const stat = vi.fn().mockResolvedValue(null);
        const mkdir = vi.fn().mockResolvedValue(undefined);
        const list = vi.fn().mockResolvedValue({ files: [], folders: [] });
        const app = {
            vault: {
                adapter: { exists, stat, mkdir, list },
            },
        } as unknown as App;
        const adapter = new ObsidianStorageAdapter(app);

        await expect(adapter.exists("")).resolves.toBe(true);
        await expect(adapter.trystat("")).resolves.toBeNull();
        await expect(adapter.stat("")).resolves.toBeNull();
        await expect(adapter.mkdir("")).resolves.toBeUndefined();
        await expect(adapter.list("")).resolves.toEqual({ files: [], folders: [] });

        expect(exists).toHaveBeenCalledWith("");
        expect(stat).toHaveBeenCalledWith("");
        expect(mkdir).toHaveBeenCalledWith("");
        expect(list).toHaveBeenCalledWith("");
    });

    it("floors write-option timestamps before calling Obsidian storage methods", async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const writeBinary = vi.fn().mockResolvedValue(undefined);
        const append = vi.fn().mockResolvedValue(undefined);
        const app = {
            vault: {
                adapter: {
                    write,
                    writeBinary,
                    append,
                },
            },
        } as unknown as App;
        const adapter = new ObsidianStorageAdapter(app);
        const options = { ctime: 1778511180024.462, mtime: 1778511180999.913 };
        const expectedOptions = { ctime: 1778511180024, mtime: 1778511180999 };

        await adapter.write("note.md", "text", options);
        await adapter.writeBinary("image.bin", new ArrayBuffer(0), options);
        await adapter.append("log.md", "text", options);

        expect(write).toHaveBeenCalledWith("note.md", "text", expectedOptions);
        expect(writeBinary).toHaveBeenCalledWith("image.bin", expect.any(ArrayBuffer), expectedOptions);
        expect(append).toHaveBeenCalledWith("log.md", "text", expectedOptions);
        expect(options).toEqual({ ctime: 1778511180024.462, mtime: 1778511180999.913 });
    });
});
