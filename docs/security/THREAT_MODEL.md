# Threat model

## Assets

- Vault contents and metadata.
- CouchDB, object-storage, JWT, custom-header, and encryption credentials.
- Setup URIs, local persisted settings, logs, and support exports.
- Release artifacts, update metadata, dependency locks, and CI identities.

## Trust boundaries

The Obsidian plugin, CLI, browser applications, storage adapters, remote endpoints, dependency registry, GitHub Actions, and release consumers are separate boundaries. Data crossing a boundary is untrusted until parsed, bounded, and validated. Credentials may exist in process memory when needed but must not cross into Markdown, logs, support bundles, or plaintext persistence.

## Primary abuse cases

- Persisting credentials after passphrase retrieval or encryption fails.
- Exporting credentials through settings Markdown, Setup URIs, logs, or diagnostics.
- Redirecting network operations to attacker-controlled endpoints or loading remote code.
- Traversal, symlink, archive, or destructive file-operation attacks.
- Dependency, action, registry, tag, or release-artifact substitution.
- Running untrusted pull-request code with write tokens, repository secrets, or self-hosted runners.

## Required controls

Persistence and export paths fail closed, errors contain field names rather than values, external actions are pinned to complete commits, pull requests receive read-only tokens, and release artifacts are built from a locked identity. The complete review scope is in [REVIEW_SCOPE.md](REVIEW_SCOPE.md).
