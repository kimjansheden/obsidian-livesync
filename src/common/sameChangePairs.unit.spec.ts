import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SameChangePairs } from "./sameChangePairs";

describe("same-change timestamp persistence", () => {
    let values: Map<string, string>;

    beforeEach(() => {
        vi.useFakeTimers();
        values = new Map();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("reclaims a full legacy cache without dropping distinct-time or internal-file equivalences", () => {
        const redundant = Array.from({ length: 65_000 }, (_, index) => [
            `notes/synthetic-${index}.md`,
            [1_700_000_000_000, 1_700_000_000_245],
        ]);
        const required = [
            ["notes/changed.md", [1_700_000_000_000, 1_700_000_002_000]],
            ["i:settings.json", [1_700_000_000_000, 1_700_000_000_245]],
            [".obsidian/settings.json", [1_700_000_000_000, 1_700_000_000_245]],
            [".custom-config/settings.json", [1_700_000_000_000, 1_700_000_000_245]],
        ];
        values.set("cache", JSON.stringify([...redundant, ...required]));
        values.set("mobile-selected-vault", "synthetic-vault");

        const cache = new SameChangePairs("cache");

        expect(JSON.parse(values.get("cache")!)).toEqual(required);
        expect(cache.get("notes/changed.md")).toEqual(required[0][1]);
        expect(values.get("mobile-selected-vault")).toBe("synthetic-vault");
    });

    it("does not grow the cache when ordinary writes only change sub-resolution timestamps", async () => {
        const cache = new SameChangePairs("cache");
        for (let index = 0; index < 65_000; index++) {
            cache.set(`notes/synthetic-${index}.md`, [1_700_000_000_000, 1_700_000_000_999]);
        }
        await vi.runAllTimersAsync();
        expect(cache._map.size).toBe(0);
        expect(values.has("cache")).toBe(false);
    });

    it("preserves a transitive equivalence chain across comparison windows and reloads", async () => {
        const cache = new SameChangePairs("cache");
        const times = [1_700_000_000_000, 1_700_000_002_000, 1_700_000_002_100];
        cache.set("notes/changed.md", times);
        await vi.runAllTimersAsync();
        expect(new SameChangePairs("cache").get("notes/changed.md")).toEqual(times);
    });

    it("retains timestamps which cross a two-second boundary even when only one millisecond apart", async () => {
        const cache = new SameChangePairs("cache");
        const times = [1_700_000_001_999, 1_700_000_002_000];
        cache.set("notes/boundary.md", times);
        await vi.runAllTimersAsync();
        expect(new SameChangePairs("cache").get("notes/boundary.md")).toEqual(times);
    });

    it("leaves malformed persisted records intact instead of claiming they are redundant", () => {
        const persisted = [
            ["notes/unknown.md", null],
            ["notes/non-number.md", [null, 42]],
        ];
        values.set("cache", JSON.stringify(persisted));
        new SameChangePairs("cache");
        expect(JSON.parse(values.get("cache")!)).toEqual(persisted);
    });
});
