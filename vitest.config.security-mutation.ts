import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["scripts/security/*.mutation.unit.spec.ts"],
    },
});
