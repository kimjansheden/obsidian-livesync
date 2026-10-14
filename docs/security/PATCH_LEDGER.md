# Security patch ledger

Each fork patch is isolated so it can be reviewed, proposed upstream, or removed independently.

| Patch | Purpose | Public regression evidence |
| --- | --- | --- |
| `SEC-001` | Never export credentials or encrypted credential blobs to settings Markdown. | `settingsPersistence.unit.spec.ts` covers both legacy credential-sync flag states. |
| `SEC-002` | Refuse plaintext settings at Obsidian, CLI, and browser persistence boundaries; scrub auxiliary fields already represented by the encrypted connection. | `settingsPersistence.unit.spec.ts`, browser context tests, type checks, and build. |
| `SEC-003` | Remove vulnerable locked dependencies and prevent reintroduction. | `npm audit --audit-level=low` and dependency-review workflow. |
| `SEC-004` | Replace inherited workflows with least-privilege, full-SHA-pinned security workflows. | `verify-repository-policy.mjs` and GitHub workflow runs. |
| `SEC-005` | Consume the security-qualified Commonlib release by immutable release URL, lock integrity, SHA-256, source receipt, and GitHub attestation. | `ObsidianSettingService.persistence.unit.spec.ts`, `security-release-workflow.test.mjs`, repository policy, and release workflow runs. |
| `SEC-006` | Install a release from the vault only as a package signed by a key which the device trusts, newer than the running build and verified file by file; keep the trusted keys out of reach of synchronised content; restore the previous build when the new one does not load. | `releasePackage.unit.spec.ts` (every verification rule and their order, and the documented example), `releaseInstaller.unit.spec.ts`, `releaseInstallCoordinator.unit.spec.ts`, `useReleaseInstall.unit.spec.ts`, `trustedReleaseKeys.unit.spec.ts`, `ServiceFileAccessImpl.trustedReleaseKeys.unit.spec.ts`, and the `trustedReleaseKeys` specs of Hidden File Sync and Customisation Sync. |
| `SEC-007` | Carry the release number in every build exactly once, and refuse a build or a release tag which disagrees with the declared number. | `verify-release-marker.mutation.unit.spec.ts`, `security-release-workflow.test.mjs`, `verify-repository-policy.mjs`, and the production build. |
| `SEC-008` | Stop an unloaded instance from starting a replication, processing a storage event or applying a database change to storage. | `ModuleObsidianEvents.unit.spec.ts`, `ReplicateResultProcessor.unit.spec.ts`, `ModuleReplicatorMinIO.unit.spec.ts`, `ModuleReplicatorCouchDB.unit.spec.ts`, `CmdHiddenFileSync.trustedReleaseKeys.unit.spec.ts`, and the lifecycle, replication, storage-event and file-handler specs of Commonlib. |

The upstream `1.0.21` workflows were reviewed before Actions was enabled on this fork. They were removed because they used mutable action tags and included publication/deployment privileges outside this fork's current scope.
