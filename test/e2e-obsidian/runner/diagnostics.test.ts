import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { createDiagnosticsDirectory } from "./diagnostics.ts";

const created: string[] = [];

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("secure diagnostics directories", () => {
    it("creates a fresh unpredictable directory for every default invocation", async () => {
        const first = await createDiagnosticsDirectory("unit");
        const second = await createDiagnosticsDirectory("unit");
        created.push(first, second);

        expect(first).not.toBe(second);
        expect(first.startsWith(tmpdir())).toBe(true);
        await expect(access(first)).resolves.toBeUndefined();
        await expect(access(second)).resolves.toBeUndefined();
    });
});
