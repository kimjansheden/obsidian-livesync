# Security patch ledger

Each fork patch is isolated so it can be reviewed, proposed upstream, or removed independently.

| Patch | Purpose | Public regression evidence |
| --- | --- | --- |
| `SEC-001` | Never export credentials or encrypted credential blobs to settings Markdown. | `settingsPersistence.unit.spec.ts` covers both legacy credential-sync flag states. |
| `SEC-002` | Refuse plaintext settings at Obsidian, CLI, and browser persistence boundaries; scrub auxiliary fields already represented by the encrypted connection. | `settingsPersistence.unit.spec.ts`, browser context tests, type checks, and build. |
| `SEC-003` | Remove vulnerable locked dependencies and prevent reintroduction. | `npm audit --audit-level=low` and dependency-review workflow. |
| `SEC-004` | Replace inherited workflows with least-privilege, full-SHA-pinned security workflows. | `verify-repository-policy.mjs` and GitHub workflow runs. |

The upstream `1.0.21` workflows were reviewed before Actions was enabled on this fork. They were removed because they used mutable action tags and included publication/deployment privileges outside this fork's current scope.
