# On-demand attachments on Android

On-demand attachments keep Markdown notes in the Vault while moving older attachments into a recoverable cache beside it. Obsidian then lists fewer physical files at start-up. Viewed embeds and opened attachment links are materialised automatically. The cache belongs to this device and is not a synchronised deletion.

The command **Use older attachments on demand** requires Object Storage synchronisation, the supported Android shared-storage adapter, and a bootstrap whose oldest runnable fallback supports release 22. Keep older bootstrap recovery copies outside the active plug-in directory. An older runtime must never open a Vault with deferred attachments.

Preparation publishes pending originals, verifies each eligible file against its exact local database revision, saves its immutable chunk descriptor, and moves the original with an atomic native rename. It preserves notes, hidden files, recently changed files, unsupported attachment types, and files larger than 16 MiB. The initial age threshold is seven days. Files whose database revision or content cannot be proved remain resident. Legacy R2 indexes are resolved only when remote content is needed; preparation does not scan the entire remote archive before moving preserved originals.

Synchronisation pauses during the migration. Preparation checks synchronisation targets before moving any originals, then handles at most four files concurrently. Changing settings stops the preparation. Restart Obsidian after preparation finishes, or if preparation stops. The saved records protect both complete and interrupted moves. Do not manually remove the sibling `.livesync-attachment-cache` directory or its device-local records.

During preparation, Android events for retired attachments are ignored; restart Obsidian to refresh its file listing. Events for notes and resident files continue normally. The temporary event filter is removed after success, cancellation, or failure, and preserves a handler installed by another owner.

Each original also has an independent recovery description beside its cached bytes. A small native checkpoint verifies the active database registry at start-up without opening every attachment. Missing registry entries or an interrupted checkpoint pause synchronisation before absent files can be interpreted as deletions. **Recover preserved attachment originals** restores those copies and verifies their hashes, including when the local registry has been lost. Existing different content is preserved and the recovered original receives a distinct recovery filename. Restart Obsidian after recovery; do not remove recovery descriptions or older bootstrap copies until their originals have been secured.

**Stop preparing attachments** cancels publication or finishes the file operations already in progress and starts no further files. Preparation can continue in the same session; originals and durable recovery records remain intact. Synchronisation stays paused until restart after file offloading begins.

An available cached original opens offline. If that copy is unavailable, the plug-in reads the exact encrypted content from R2, verifies its size and SHA-256, and restores it before normal file reconciliation. Offline access cannot fetch a missing copy; opening it again retries. A concurrently created file is preserved, and an existing cached original is retained for recovery.

**Make cached attachments available offline** restores the deferred originals. A restored file participates in the ordinary synchronisation and conflict-preservation path. Larger files retain the existing bounded transfer path.

Start-up time depends on the resident file count and the device. Commonlib content tests and native-adapter unit tests do not establish a particular Android start-up time.
