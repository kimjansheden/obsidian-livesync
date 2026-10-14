# Security review scope

The declared matrix covers every tracked first-party source file, script, workflow, and configuration file at the release commit. Dependencies are covered by the exact npm lock graph, npm/OSV advisories, dependency review, SBOM and licence inventory, and package integrity metadata. The security-qualified Commonlib dependency is additionally bound to its public repository, upstream base, fork commit, signed tag, immutable release URL, lock-file hash, package hash, source-receipt hash, release workflow, and GitHub attestations in `commonlib-release.json`.

Manual semantic review covers credentials, cryptography and key derivation, Setup URIs, Markdown export, local persistence, network targets, file operations, dynamic code, logging and support exports, and plugin/update behavior. Update behaviour includes the installation of signed releases from the vault: the package verifier, the trusted-keys file and the guard which keeps it from being written, the staging, replacement and restoration of the plug-in's own files, and what an instance may still do after it has been unloaded. Security-critical third-party code is reviewed from integrity-verified packages when a first-party claim depends on its behavior.

The matrix does not claim a manual line-by-line review of every transitive dependency. Those dependencies remain covered by the lock, advisory, provenance, and inventory controls. A scanner result is not closed until it is fixed or a reproducible review demonstrates that it is a false positive.

## Required release evidence

- Repository URL, upstream base commit, fork commit, and tag.
- The release number declared in `security-release.json`, the tag which names it, and the result of the release marker check on the built `main.js`.
- SHA-256 of the lock file, Commonlib receipt, patch series, SBOM, licence inventory, and each distributed artefact.
- Exact scanner/action versions and advisory observation time.
- CodeQL, dependency, secret/history, workflow-policy, semantic-review, and test results.
- Two clean build manifests and a reproducibility comparison.
- GitHub artifact attestation verification.

Release tags use SSH signatures. The public verifier identity is versioned in `release-signers.allowed`; the corresponding private key is kept outside the repository and is used only for this fork.
