# 1.0

Well then, everyone: it has been roughly a year since I declared the 0.25 beta. During that time, we have concentrated mainly on fixing defects and completing the features that the project needed.

Version 1.0 has been in mind for some time. We have now brought together the work intended to make it possible: stronger CI, more detailed tests, an E2E runner suited to synchronisation, and testing tools for physical devices. These now form a coherent Kit rather than a collection of isolated pieces. With those foundations in place, it seems that the time has finally come to reshape the structure of this repository.

None of this would have been possible without your issue reports, pull requests, sponsorship, and the support provided through OpenAI's Codex for Open Source. I would like to express my gratitude once again. As with every pull request contributed to the project, code produced with Codex and similar tools is reviewed and audited by me, vrtmrz. Anyone interested in how I manage that process can refer to my dotfiles.

This will call for your help once again. I would be very grateful for your co-operation as we build a sounder foundation for the project and its future development.

Earlier releases remain available in the 1.0 release history, the 1.0 preview history, the 0.25 release history, and the legacy release history.

## Unreleased

### Synchronisation and storage

#### Fixed

- Object Storage connection settings are now encrypted before the host persistence boundary, scrubbed from the plaintext settings record, and restored after restarting the plug-in. Saving a pure S3-compatible profile no longer fails the plaintext-credential guard before the encrypted connection has been created.
- Finite Object Storage synchronisation now persists queued generations, resumes them after startup, serialises lease changes atomically across browser contexts, and advances remote journal cursors only after local application succeeds.
- Locked Object Storage remotes now reject unaccepted nodes before they can refresh milestone heartbeats, while accepted nodes retain read-only compatibility checks.
- A device restored by fetching an Object Storage remote no longer reads its whole local database again on every synchronisation cycle before receiving new changes. The first send after the restore still scans the received entries once.
- A file created, changed, deleted or renamed while the plug-in was starting, after the start-up scan had listed the vault but before the vault watcher began, no longer stays unsynchronised until the next start. A rename which only changes letter case, when file names are not case-sensitive, is still left to a later scan. These changes, and storage operations restored after a restart, now leave a file which still holds the revision this device last wrote or stored, so a newer edit received in the meantime is not replaced. A deletion received during start-up may still be undone to keep local work.
- Remediation mode reflects received documents again. The mode applies only the documents modified before the configured moment, and it prevents the start-up scan which readiness depends upon, so the plug-in stays unready for as long as the limit is configured. Holding received documents until readiness therefore left the mode unable to restore anything, which in practice means a fetch performed to recover an earlier state, since automatic replication does not start in this mode either. Received documents are applied again while the local database is usable, each one still within the configured limit, and storage events stay unqueued so local changes are not sent. A file whose local copy differs is preserved as a conflict; resolving conflicts automatically by the newest file can therefore take back part of what was restored.
- Received changes are no longer applied to the Vault before the plug-in is ready, such as during start-up or while fetching from the remote. Changes held back meanwhile, including those restored after a restart, are applied as soon as the plug-in becomes ready, without waiting for another change to arrive.
- A fetch performed in remediation mode can now complete. The mode reflects only the documents modified before the configured moment, and it prevents the reconciliation scan between storage and the local database; the fetch requested that prevented scan twice and treated each refusal as a failure, so it ended in an error after the local database had been reset. Both scans are now skipped in this mode, the files in the Vault are no longer stored in the database first, and the plug-in stays restricted afterwards instead of reporting readiness which the prevented scan cannot support. Rebuilding, which publishes the current Vault as the remote, is refused while the mode is active, before the local database is reset.
- A scheduled fetch now opens the detailed flow instead of Simple Fetch while remediation mode is active. After fetching, Simple Fetch reconciled the Vault with the local database directly, past the check which prevents that scan in this mode, so depending on the selected handling it stored the files in the Vault in the local database, wrote documents modified after the configured moment to the Vault, or deleted local files. Skipping only that scan would have restored nothing from most remotes: Simple Fetch suspends the reflection of received documents while fetching, so Object Storage and P2P remotes discard those documents, and a CouchDB Fast Fetch stores them in the local database without reflecting them. The detailed flow skips the scan in this mode too, and applies the documents it receives from a CouchDB or Object Storage remote within the limit, provided their reflection has not been left suspended. A P2P remote still restores nothing in this mode, because the detailed flow also suspends reflection while fetching from it and the received documents are discarded.
- Resetting the journal history of an Object Storage remote, or deleting the remote, is no longer undone by a synchronisation which is already running. Such a synchronisation now stops instead of recording what it did before the reset, so the next one sends everything again from the reset position. After another device has deleted the remote, this device also sends its own changes to the new remote again, and the ones the new remote already holds are skipped.
- Customisation Sync no longer handles a detected change to a configuration file before the plug-in is ready, such as a storage operation restored during start-up. The next scan of configuration files stores the change instead; during start-up, that is the scan performed while the local database is prepared.
- Customisation Sync no longer scans configuration files when settings are applied while all synchronisation is suspended, such as with the 'Toggle All Sync' command, and **Scan customisation periodically** no longer keeps scanning meanwhile. While synchronisation is active, applying settings still scans them once when **Scan customisation automatically** is enabled, as before.
- Received changes to files of at least 50 MiB are applied one at a time, and so are received changes which replace or delete a local file of at least 50 MiB; smaller files continue beside them. The start-up scan also processes files of at least 50 MiB one at a time, and so does the storing of changes in the Vault, for example when several large files are added at once. A received file of at least 50 MiB which can be written in parts is no longer loaded whole before it is written; only the availability of its chunks is checked first. A deletion or new version of a local file of at least 50 MiB no longer reads the whole file to look for unsynchronised changes when the file system still reports the modification time and size which this device recorded when it last applied that version from the database, and the change was made on that version. Otherwise the file is compared as before, and a local change is still preserved as a conflict. Deleting a binary file in the Vault no longer loads its content from the database either; only the availability of its chunks is checked. Several large files which arrive together are therefore no longer held in memory at the same time; how much memory a single large file needs still depends on the device.
- A file which the start-up scan could not process no longer stops start-up, provided the local database is ready and the scan itself completed. Start-up continues, synchronisation starts, and the log states how each such file is tried again. A file which could not be written from the database, typically because its chunks had not arrived when the app was closed while receiving it, is applied by the queue of received changes once the plug-in is ready. A change in the Vault which could not be stored into the database, or a deletion made while the app was closed, is queued again as a storage change. Anything else is tried again by the next full scan. A database which is not ready, a scan which could not run, or an error in the scan still stop start-up, as before.
- A received file whose chunks have not arrived is no longer dropped until the next start-up. It waits, also across a restart, and is tried again before every synchronisation until it is written or a newer version replaces it; only its first failure shows a notice. It also stops waiting when it is no longer synchronised, for example because of the size limit.

## 1.0.21

26th August, 2026

It is becoming more 'ordinary' with each release, but please let me know if anything has become less convenient.

### Interface and translation

#### Fixed

- Remote Configuration section headings no longer overlap their contents when scrolling on mobile. Action buttons in Remote Configuration, Maintenance, and Patches now remain inside the settings pane on narrow screens.

## 1.0.20

~~1.0.19~~ was cancelled because prerelease validation exposed an incorrect warning at start-up.

25th August, 2026

I know this is the second time I have said it, but I had grown quite fond of the settings screen. It seems, however, that a simpler, healthier life is called for.

### Interface and translation

#### Fixed

- Compatibility pause warnings now direct you to the dedicated compatibility review instead of the Change Log.
- The Obsidian 1.13 settings page now waits for saved settings before choosing its initial layout. This prevents a spurious missing-replicator warning at start-up, keeps configured devices on the Synchronisation-first layout even when automatic synchronisation triggers are disabled, and keeps Quick Setup first on unconfigured devices.

#### Improved

- Settings page names, controls in General Settings, Quick Setup actions, and Advanced controls now use Obsidian 1.13's native settings interface and global search, while retaining their familiar icons. The landing page keeps Remote Configuration and Sync Settings together, places Appearance, Logging, and Extra menus under General Settings, and groups maintenance, optional features, advanced settings, and help by purpose. Earlier supported Obsidian versions continue to use the pane-based interface.
- Settings changes which require database initialisation now use a focused Setup Manager dialogue to choose between existing synchronisation data and the files in the current Vault. The selected reset or rebuild is reserved before the settings are saved, while cancelling offers a separate, explicit settings-only fallback.

## 1.0.18

24th August, 2026

### Synchronisation and storage

#### Fixed

- Reset and rebuild workflows now use the local database selected by their updated settings, preventing stale data from reopening after a **Database Suffix** change. If database initialisation does not complete, the workflow remains paused instead of continuing with incomplete state.

#### Improved

- Rebuilds now recheck restored file events against the current Vault, use current file contents, and finish processing them before the plug-in reports readiness.

## 1.0.17

23rd August, 2026

### Interface and translation

#### Fixed

- Settings generated from the settings manifest, Setup Wizard configuration summaries, and warnings about externally changed settings now honour **Display language** when a translation is available, instead of remaining in English (PR #1123). Thank you to @nimula for the contribution!

### Peer-to-peer synchronisation

#### Improved

- P2P connection profiles now provide four **P2P message size** presets and a **Connection path** choice between **Automatic** and **TURN relay only**. Smaller messages can improve compatibility on paths which fragment or drop larger WebRTC messages, while relay-only routing requires a configured TURN server. P2P connection strings and encrypted Setup URIs preserve both choices.
    - Thank you to @andrewschreiber for the detailed fragmentation diagnosis and working 800-byte threshold in vrtmrz/livesync-commonlib#97, which informed this compatibility design.
- An optional self-hosted Coturn Compose starter is now available for P2P deployments that need a TURN relay. It uses a pinned upstream image and documents its network, credential, security, and verification boundaries.

## 1.0.16

19th August, 2026

### Conflict handling and recovery

#### Fixed

- **Back to this revision** in Document History now restores the selected content as a new non-deleted successor revision before reflecting it to the Vault. A readable revision restored after a logical deletion therefore remains restored through later synchronisation instead of being overwritten by the deletion.
    - If the file changes while restoration is in progress, the operation stops instead of extending a stale revision. Existing conflicts remain available through **Inspect conflicts and file/database differences**.

### Synchronisation and storage

#### Improved

- One-shot CouchDB synchronisation now releases stalled web-compatible connection checks before replication starts, so a later synchronisation can make a fresh attempt (Commonlib 0.1.16).
    - The 60-second safeguard applies only to pre-replication checks. It does not limit ordinary synchronisation, and the **Use Internal API** path is unchanged.
