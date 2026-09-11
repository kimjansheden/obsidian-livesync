import { describe, expect, it } from "vitest";
import {
    isMergeableJsonDocument,
    parseMergeableJsonDocument,
    parseSelectableJsonDocument,
    shouldKeepValidLocalJson,
} from "./jsonConflictPolicy.ts";

describe("hidden-file JSON conflict policy", () => {
    it("accepts object JSON documents and rejects arrays", () => {
        expect(isMergeableJsonDocument('{"enabled":true}')).toBe(true);
        expect(isMergeableJsonDocument("[1,2,3]")).toBe(false);
    });

    it("rejects invalid, null, and scalar JSON documents", () => {
        expect(parseMergeableJsonDocument('{"enabled":')).toBe(false);
        expect(parseMergeableJsonDocument("null")).toBe(false);
        expect(parseMergeableJsonDocument('"credential"')).toBe(false);
    });

    it("lets object and array revisions be kept as a whole but not invalid or scalar ones", () => {
        expect(parseSelectableJsonDocument('{"enabled":true}')).toEqual({ enabled: true });
        expect(parseSelectableJsonDocument('["example-plugin"]')).toEqual(["example-plugin"]);
        expect(parseSelectableJsonDocument('["example-plugin"')).toBe(false);
        expect(parseSelectableJsonDocument("null")).toBe(false);
        expect(parseSelectableJsonDocument("42")).toBe(false);
    });

    it("keeps a valid local JSON file when the incoming revision is invalid JSON", () => {
        expect(shouldKeepValidLocalJson(".obsidian/app.json", '{"livePreview":', '{"livePreview":true}')).toBe(true);
        expect(shouldKeepValidLocalJson(".obsidian/app.json", '{"livePreview":false}', '{"livePreview":true}')).toBe(
            false
        );
        expect(shouldKeepValidLocalJson(".obsidian/app.json", '{"livePreview":', null)).toBe(false);
        expect(shouldKeepValidLocalJson(".obsidian/app.json", '{"livePreview":', '{"livePreview":')).toBe(false);
        expect(shouldKeepValidLocalJson(".obsidian/snippets/custom.css", "{", "body {}")).toBe(false);
    });
});
