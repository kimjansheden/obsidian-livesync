import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["scripts/security/verify-github-security-state.mutation.unit.spec.ts"],
    },
});
