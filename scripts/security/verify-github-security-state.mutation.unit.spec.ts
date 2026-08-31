import { describe, expect, it } from "vitest";

import {
    enforceGitHubCodeQLState,
    enforceGitHubSecurityState,
    evaluateGitHubCodeQLState,
    evaluateGitHubSecurityState,
} from "./verify-github-security-state.mjs";

const expectedSha = "a".repeat(40);

function cleanState() {
    return {
        expectedSha,
        ref: "refs/heads/main",
        resolvedRefSha: expectedSha,
        analyses: [
            { commit_sha: expectedSha, category: "/language:actions", error: "" },
            { commit_sha: expectedSha, category: "/language:javascript-typescript", error: "" },
        ],
        codeScanningAlerts: [],
        dependabotAlerts: [],
        secretScanningAlerts: [],
    };
}

describe("GitHub zero-open-alert release gate mutation sensitivity", () => {
    it("accepts a fully analysed CodeQL-only state and rejects an alert", () => {
        const clean = cleanState();
        expect(evaluateGitHubCodeQLState(clean)).toEqual({
            ok: true,
            errors: [],
            counts: { codeScanning: 0 },
        });
        expect(enforceGitHubCodeQLState(clean)).toEqual({
            ok: true,
            errors: [],
            counts: { codeScanning: 0 },
        });

        const alerted = cleanState();
        alerted.codeScanningAlerts.push({ number: 1 } as never);
        expect(evaluateGitHubCodeQLState(alerted).ok).toBe(false);
        expect(() => enforceGitHubCodeQLState(alerted)).toThrow("CodeQL has 1 open alert(s)");
    });

    it("accepts the one fully analysed state with no open alerts", () => {
        const state = cleanState();
        expect(evaluateGitHubSecurityState(state)).toEqual({
            ok: true,
            errors: [],
            counts: { codeScanning: 0, dependabot: 0, secretScanning: 0 },
        });
        expect(() => enforceGitHubSecurityState(state)).not.toThrow();
    });

    it("accepts successful analyses whose API payload omits the empty error field", () => {
        const state = cleanState();
        state.analyses = state.analyses.map(({ error: _error, ...analysis }) => analysis as never);

        expect(evaluateGitHubCodeQLState(state)).toEqual({
            ok: true,
            errors: [],
            counts: { codeScanning: 0 },
        });
    });

    it("preserves fail-closed diagnostics when the declared ref and resolved SHA are missing", () => {
        const state = cleanState();
        state.ref = undefined as never;
        state.resolvedRefSha = undefined as never;

        expect(evaluateGitHubCodeQLState(state).errors[0]).toBe(
            `Expected commit ${expectedSha} does not match the declared ref at <missing>.`
        );
    });

    it.each([
        ["analyses", "CodeQL analyses"],
        ["codeScanningAlerts", "Code scanning alerts"],
        ["dependabotAlerts", "Dependabot alerts"],
        ["secretScanningAlerts", "Secret scanning alerts"],
    ] as const)("names a malformed %s collection in the fail-closed diagnostic", (field, label) => {
        const state = cleanState();
        state[field] = undefined as never;

        expect(evaluateGitHubSecurityState(state).errors).toContain(
            `${label} response was missing or malformed; the release gate fails closed.`
        );
    });

    it("preserves every CodeQL failure in the enforcement error", () => {
        const state = cleanState();
        state.analyses = [];
        state.codeScanningAlerts = [{ number: 1 }] as never;
        const result = evaluateGitHubCodeQLState(state);

        expect(() => enforceGitHubCodeQLState(state)).toThrow(
            new Error(`GitHub zero-open-CodeQL-alert policy failed:\n- ${result.errors.join("\n- ")}`)
        );
    });

    it("preserves every alert-class failure in the release enforcement error", () => {
        const state = cleanState();
        state.dependabotAlerts = [{ number: 1 }] as never;
        state.secretScanningAlerts = [{ number: 2 }] as never;
        const result = evaluateGitHubSecurityState(state);

        expect(() => enforceGitHubSecurityState(state)).toThrow(
            new Error(`GitHub zero-open-alert release policy failed:\n- ${result.errors.join("\n- ")}`)
        );
    });

    it.each([
        {
            mutation: "an open CodeQL alert",
            mutate: (state: ReturnType<typeof cleanState>) => state.codeScanningAlerts.push({ number: 11 } as never),
            error: "CodeQL has 1 open alert(s)",
        },
        {
            mutation: "an open Dependabot alert",
            mutate: (state: ReturnType<typeof cleanState>) => state.dependabotAlerts.push({ number: 12 } as never),
            error: "Dependabot has 1 open alert(s)",
        },
        {
            mutation: "an open secret-scanning alert",
            mutate: (state: ReturnType<typeof cleanState>) => state.secretScanningAlerts.push({ number: 13 } as never),
            error: "secret scanning has 1 open alert(s)",
        },
        {
            mutation: "a release commit different from main",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.resolvedRefSha = "b".repeat(40);
            },
            error: `does not match refs/heads/main at ${"b".repeat(40)}`,
        },
        {
            mutation: "a missing Actions analysis",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.analyses = state.analyses.filter((analysis) => analysis.category !== "/language:actions");
            },
            error: "lacks a successful CodeQL analysis for /language:actions",
        },
        {
            mutation: "a failed JavaScript and TypeScript analysis",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.analyses[1].error = "analysis failed";
            },
            error: "lacks a successful CodeQL analysis for /language:javascript-typescript",
        },
        {
            mutation: "analyses from an older commit",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.analyses = state.analyses.map((analysis) => ({ ...analysis, commit_sha: "c".repeat(40) }));
            },
            error: "lacks a successful CodeQL analysis",
        },
        {
            mutation: "a malformed alert response",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.codeScanningAlerts = undefined as never;
            },
            error: "response was missing or malformed",
            expectedCount: 0,
        },
        {
            mutation: "a malformed CodeQL analysis entry",
            mutate: (state: ReturnType<typeof cleanState>) => {
                state.analyses = [undefined as never];
            },
            error: "lacks a successful CodeQL analysis",
        },
    ])("turns the gate red for $mutation", ({ mutate, error, expectedCount }) => {
        const state = cleanState();
        mutate(state);

        const result = evaluateGitHubSecurityState(state);

        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain(error);
        if (expectedCount !== undefined) expect(result.counts.codeScanning).toBe(expectedCount);
        expect(() => enforceGitHubSecurityState(state)).toThrow(error);
    });
});
