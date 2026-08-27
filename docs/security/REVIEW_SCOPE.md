# Security review scope

The declared matrix covers every tracked first-party source file, script, workflow, and configuration file at the release commit. Dependencies are covered by the exact npm lock graph, npm/OSV advisories, dependency review, SBOM and license inventory, and registry integrity metadata.

Manual semantic review covers credentials, cryptography and key derivation, Setup URIs, Markdown export, local persistence, network targets, file operations, dynamic code, logging and support exports, and plugin/update behavior. Security-critical third-party code is reviewed from integrity-verified packages when a first-party claim depends on its behavior.

The matrix does not claim a manual line-by-line review of every transitive dependency. Those dependencies remain covered by the lock, advisory, provenance, and inventory controls. A scanner result is not closed until it is fixed or a reproducible review demonstrates that it is a false positive.

## Required release evidence

- Repository URL, upstream base commit, fork commit, and tag.
- SHA-256 of the lock file, patch series, SBOM, and each distributed artifact.
- Exact scanner/action versions and advisory observation time.
- CodeQL, dependency, secret/history, workflow-policy, semantic-review, and test results.
- Two clean build manifests and a reproducibility comparison.
- GitHub artifact attestation verification.

Release tags use SSH signatures. The public verifier identity is versioned in `release-signers.allowed`; the corresponding private key is kept outside the repository and is used only for this fork.
