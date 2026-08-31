import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { validateCommonlibSourceReceipt } from "../scripts/security/verify-commonlib-source-receipt.mjs";

const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const commonlibIdentity = JSON.parse(
    await readFile(new URL("../docs/security/commonlib-release.json", import.meta.url), "utf8")
);
const validCommonlibReceipt = {
    repository: commonlibIdentity.repositorySlug,
    upstreamRepository: commonlibIdentity.upstreamRepository,
    upstreamBase: commonlibIdentity.upstreamBase,
    commit: commonlibIdentity.forkCommit,
    tag: commonlibIdentity.tag,
    lockfileSha256: commonlibIdentity.packageLockSha256,
    packageSha256: commonlibIdentity.packageSha256,
    workflowRun: commonlibIdentity.releaseWorkflowRun,
};

function sourceReceiptJqContract(workflow) {
    const command = workflow.split(/\r?\n/u).find((line) => line.includes("jq -n --arg repository"));
    assert.ok(command, "source-receipt jq command is missing");

    const commandParts = command.match(/jq -n (?<arguments>.*?) '(?<program>\{.*\})' >/u);
    assert.ok(commandParts?.groups, "source-receipt jq command cannot be parsed");

    const declared = [...commandParts.groups.arguments.matchAll(/--arg\s+([A-Za-z][A-Za-z0-9]*)\s+/gu)].map(
        ([, name]) => name
    );
    const referenced = [...commandParts.groups.program.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/gu)].map(([, name]) => name);
    return {
        declared: [...new Set(declared)].sort(),
        referenced: [...new Set(referenced)].sort(),
    };
}

describe("attested security release workflow", () => {
    it("keeps publication behind the release environment", () => {
        assert.match(releaseWorkflow, /^\s{4}environment: release$/mu);
    });

    it("verifies the exact Commonlib release before installing dependencies", () => {
        const verification = releaseWorkflow.indexOf("name: Verify the attested Commonlib dependency");
        const installation = releaseWorkflow.indexOf("name: Install locked dependencies");

        assert.notEqual(verification, -1, "Commonlib attestation verification is missing");
        assert.ok(verification < installation, "Commonlib must be verified before npm installs it");
        assert.match(releaseWorkflow, /gh attestation verify/u);
        assert.match(releaseWorkflow, /sha256sum --check/u);
        assert.match(releaseWorkflow, /verify-commonlib-source-receipt\.mjs/u);
    });

    it("accepts only a Commonlib receipt whose complete identity agrees", () => {
        assert.doesNotThrow(() => validateCommonlibSourceReceipt(commonlibIdentity, validCommonlibReceipt));
    });

    it("rejects a stale Commonlib lock-file hash", () => {
        assert.throws(
            () =>
                validateCommonlibSourceReceipt(commonlibIdentity, {
                    ...validCommonlibReceipt,
                    lockfileSha256: "0".repeat(64),
                }),
            /lockfileSha256 does not match packageLockSha256/u
        );
    });

    it("rejects a Commonlib receipt from another workflow run", () => {
        assert.throws(
            () => validateCommonlibSourceReceipt(commonlibIdentity, { ...validCommonlibReceipt, workflowRun: "0" }),
            /workflowRun does not match releaseWorkflowRun/u
        );
    });

    it("runs release workflow tests before artefact creation and publication", () => {
        const workflowTests = releaseWorkflow.indexOf("npm run test:release-workflow");
        const artefactCreation = releaseWorkflow.indexOf("name: Create SBOM, licence inventory, and source receipt");
        const publication = releaseWorkflow.indexOf("name: Publish immutable GitHub release");

        assert.notEqual(workflowTests, -1, "release workflow contract tests are missing");
        assert.ok(workflowTests < artefactCreation, "workflow tests must precede artefact creation");
        assert.ok(workflowTests < publication, "workflow tests must precede publication");
    });

    it("attests and publishes the complete release-assets directory", () => {
        assert.match(releaseWorkflow, /subject-path: release-assets\/\*/u);
        assert.match(releaseWorkflow, /gh release create "\$TAG" release-assets\/\*/u);
    });

    it("declares every source-receipt jq variable under the referenced name", () => {
        const contract = sourceReceiptJqContract(releaseWorkflow);
        assert.deepEqual(contract.referenced, contract.declared);
    });

    it("rejects drift between a declared jq argument and its receipt reference", () => {
        const mutatedWorkflow = releaseWorkflow.replace(
            "lockfileSha256:$lockfileSha256",
            "lockfileSha256:$lockfileSha"
        );
        const contract = sourceReceiptJqContract(mutatedWorkflow);
        assert.notDeepEqual(contract.referenced, contract.declared);
    });
});
