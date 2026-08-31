import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RECEIPT_FIELDS = [
    ["repository", "repositorySlug"],
    ["upstreamRepository", "upstreamRepository"],
    ["upstreamBase", "upstreamBase"],
    ["commit", "forkCommit"],
    ["tag", "tag"],
    ["lockfileSha256", "packageLockSha256"],
    ["packageSha256", "packageSha256"],
    ["workflowRun", "releaseWorkflowRun"],
];

export function validateCommonlibSourceReceipt(identity, receipt) {
    const failures = [];
    for (const [receiptField, identityField] of RECEIPT_FIELDS) {
        if (receipt?.[receiptField] !== identity?.[identityField]) {
            failures.push(`${receiptField} does not match ${identityField}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`Commonlib source receipt identity mismatch:\n- ${failures.join("\n- ")}`);
    }
}

export async function verifyCommonlibSourceReceipt(receiptPath, identityPath) {
    const [receipt, identity] = await Promise.all(
        [receiptPath, identityPath].map(async (path) => JSON.parse(await readFile(resolve(path), "utf8")))
    );
    validateCommonlibSourceReceipt(identity, receipt);
    console.log("Commonlib source receipt matches every declared release identity field.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const receiptPath = process.argv[2];
    const identityPath = process.argv[3] ?? "docs/security/commonlib-release.json";
    if (!receiptPath) {
        console.error("Usage: verify-commonlib-source-receipt.mjs <downloaded-receipt> [identity-file]");
        process.exitCode = 1;
    } else {
        verifyCommonlibSourceReceipt(receiptPath, identityPath).catch((error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
    }
}
