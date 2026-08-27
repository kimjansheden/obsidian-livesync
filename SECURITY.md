# Security Policy

This fork is a security-qualified derivative of Self-hosted LiveSync. Its release gate is:

> 0 open security findings in the declared scan matrix at commit `<SHA>`.

The claim is limited to the exact source commit, lock file, scanner versions, advisory data, and release artifacts named in a release receipt. It does not claim that unknown vulnerabilities cannot exist.

## Reporting a vulnerability

Do not open a public issue, pull request, discussion, or branch for an exploitable vulnerability. Use [GitHub's private vulnerability reporting form](../../security/advisories/new). Include affected versions, a minimal reproduction, impact, and any suggested mitigation. Please avoid real credentials or vault content.

We coordinate fixes with upstream and publish technical details only after a safe release is available. Confirmed findings are fixed; they are not suppressed or risk-accepted merely to satisfy the release gate.

## Supported releases

Only releases published by this fork with checksums, an SBOM, build provenance, and a security receipt are security-qualified. Upstream tags and arbitrary commits are not implicitly covered.
