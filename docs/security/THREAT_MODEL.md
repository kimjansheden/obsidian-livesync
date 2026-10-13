# Threat model

## Assets

- Vault contents and metadata.
- CouchDB, object-storage, JWT, custom-header, and encryption credentials.
- Setup URIs, local persisted settings, logs, and support exports.
- Release artifacts, update metadata, dependency locks, and CI identities.
- The plug-in's own files on each device, and the public keys which a device trusts to sign releases of it.

## Trust boundaries

The Obsidian plugin, CLI, browser applications, storage adapters, remote endpoints, dependency registry, GitHub Actions, and release consumers are separate boundaries. Data crossing a boundary is untrusted until parsed, bounded, and validated. Credentials may exist in process memory when needed but must not cross into Markdown, logs, support bundles, or plaintext persistence.

Vault content is not trusted to carry code. The intended path from vault content to running code is a signed release package, described in [Installing signed releases through the vault](../release_install.md). A package crosses that boundary only if it verifies against a public key in `trusted-release-keys.json`, a file in the plug-in's own folder which is the trust anchor of that path. The folder is a boundary of its own: whoever can write it can replace the code directly, so the anchor is as protected as the code it gates and no better.

A synchronised document must not reach the plug-in's folder by any other path. This was previously true only because the folder's files do not appear in the vault and so are not written back; it was not enforced, and a document whose path named a hidden location in a spelling the vault index did not hold was written straight to the file-system adapter. The plug-in's storage layer now enforces it: nothing which is synchronised, and nothing the plug-in itself does, may write, replace or remove the trust anchor, and no path may reach an existing folder or file by a name that folder does not list, so a hidden location cannot be reached under a short name, a trailing dot, or an ignorable code point. A build without this enforcement does not have it, and its security argument rests on the unenforced property alone.

## Primary abuse cases

- Persisting credentials after passphrase retrieval or encryption fails.
- Exporting credentials through settings Markdown, Setup URIs, logs, or diagnostics.
- Redirecting network operations to attacker-controlled endpoints or loading remote code.
- Getting code installed through synchronised content: a release package which is unsigned, signed with a key the device does not trust, altered after signing, older than the running build, addressed to another plug-in, or stating another release than the build inside it; a package which names a file outside the plug-in's three; or a trust anchor delivered or replaced through Hidden File Sync, Customisation Sync or an ordinary synchronised file.
- Leaving a device without a working plug-in: a release which does not load, a file which reads back incomplete after it was written, or a replacement of files while a synchronisation is running.
- An unloaded instance of the plug-in which keeps synchronising or writing beside the instance which replaced it.
- Traversal, symlink, archive, or destructive file-operation attacks.
- Dependency, action, registry, tag, or release-artifact substitution.
- Running untrusted pull-request code with write tokens, repository secrets, or self-hosted runners.

## Required controls

Persistence and export paths fail closed, errors contain field names rather than values, external actions are pinned to complete commits, pull requests receive read-only tokens, and release artefacts are built from a locked identity. Commonlib is accepted only through its immutable public security release URL after its SHA-256, lock integrity, source receipt, signer workflow, source commit, and GitHub attestations agree. The complete review scope is in [REVIEW_SCOPE.md](REVIEW_SCOPE.md).

Release installation from the vault is off until the trust anchor is placed on a device, and reads no package before that. A package is verified by a pure function, rule by rule in a fixed order, and no file content is decoded before the signature holds. Only the decoded bytes of the three fixed file names are written, under names which never come from the package. Every write is read back and compared by SHA-256, the running files are backed up, the replacement waits until nothing is synchronised, and a build which does not load, or does not report the release of its package, is replaced by the previous one and never tried again. The storage layer through which all synchronised content is written refuses the path of the trust anchor, compared after normalisation and without regard to case, and refuses any path which reaches an existing folder or file by a name that folder does not list. Each build carries its release number exactly once, which the build, continuous integration and the release workflow verify, and a release tag must name it. From the start of its unload an instance starts no replication, processes no storage event and applies no database change to storage. The residual risks are listed at the end of the feature's document.
