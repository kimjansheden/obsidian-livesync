import { describe, expect, it } from "vitest";

import { redactObject } from "./redactObject.ts";

describe("report redaction", () => {
    it("redacts only an existing own-property path", () => {
        const report = { couch_httpd_auth: { secret: "synthetic-secret" } };

        redactObject(report, "couch_httpd_auth.secret");
        redactObject(report, "missing.branch");

        expect(report).toEqual({ couch_httpd_auth: { secret: "REDACTED" } });
    });

    it("rejects prototype-property traversal", () => {
        const report: Record<string, unknown> = {};

        redactObject(report, "__proto__.polluted");
        redactObject(report, "constructor.prototype.polluted");

        expect(({} as { polluted?: string }).polluted).toBeUndefined();
        expect(Object.getPrototypeOf(report)).toBe(Object.prototype);
    });
});
