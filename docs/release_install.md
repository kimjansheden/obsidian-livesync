# Installing signed releases through the vault

The plug-in can install a newer release of itself from a signed package file which arrives in the vault like any other file. It verifies the package against a public key which is trusted on that device, activates the new payload through its platform installation path, reloads itself, and checks that the new build is running. If the new build does not load while the installer is running, it puts the previous build back. Desktop installations use a native file-system operation which atomically replaces an existing file. Mobile installations use the permanent bootstrap described below; a mobile fs.rename shim is never treated as an atomic replacement.

The plug-in never fetches code from the network. The only source is a file in the vault, and a file is installed only if it carries a valid signature from a key in the device's own trust file.

The feature is off until a trust file is placed on the device. There is no setting for it.

## Turning it on: the trusted keys

The trust anchor is the file `trusted-release-keys.json` in the plug-in's own folder, beside `main.js`:

```jsonc
{
    "format": 1,
    "keys": ["<base64 of the SPKI DER form of an ECDSA P-256 public key>"],
}
```

- The file is parsed strictly: UTF-8 JSON, an object with exactly the fields `format` (the number `1`) and `keys`, and one to eight keys. Each key is standard base64 with padding, in the single spelling which encoding its bytes produces, and must be importable by WebCrypto as an ECDSA P-256 public key in SPKI form.
- The file is read when the plug-in loads. A change to it takes effect the next time the plug-in loads.
- Without the file the feature is off, silently, and package files in the vault are not even read.
- With a file which is not valid the feature is off, and a notice says so once per start.
- The feature is also off in an app which offers no storage local to the device (Obsidian before 1.8.7), because a package whose build does not load could not be remembered there. The log line below says so.
- The plug-in never writes, replaces or removes this file, and nothing which is synchronised can: the plug-in's storage layer refuses every write, append, removal and directory creation at that path, compared after normalisation and without regard to case. Hidden File Sync and Customisation Sync neither store the file nor apply one. The storage layer also enforces that no path may reach an existing folder or file by a name which that folder does not list (a short name such as `OBSIDI~1`, a trailing dot, an ignorable code point), so the guard holds for the name the file system actually uses, not only for the spelling in the document; see [What the storage layer enforces](#what-the-storage-layer-enforces).
- It is not a setting. It does not appear in the settings, in a Setup URI or QR code, in the settings Markdown file, or in the values which devices compare with each other.

Whoever can write the plug-in's folder can already replace `main.js`. The trusted keys are therefore exactly as protected as the code they gate, and the same routes which install the plug-in by hand can place the file.

The identifier of a key is the first 16 hexadecimal characters of the SHA-256 of the key's DER bytes, that is, of the decoded bytes and not of the base64 text. The plug-in computes it itself for every trusted key.

At start-up the plug-in writes one line to its log, which states whether the feature is on, the identifiers of the trusted keys, and the release number of the running build:

```console
Installing releases from the vault is on, trusted keys: f1204a3af05cb801. Running release: 3.
```

## The package file

A package is a single JSON file in UTF-8. White space and the order of the keys in the file do not matter, because the signature is computed over a canonical form which the verifier builds itself.

A package is any file in the vault with the extension `.livesync-release`, wherever it lies. Only the content counts: a file which was renamed is verified and treated according to what it holds.

| Field                 | Value                                                                              |
| --------------------- | ---------------------------------------------------------------------------------- |
| `format`              | The number `1`                                                                     |
| `pluginId`            | The identifier of the plug-in, as in its `manifest.json`                           |
| `releaseName`         | The tag of the release, `<version>-security.<n>`. Used in messages only            |
| `releaseNumber`       | A positive integer which orders the releases: the `<n>` of the tag                 |
| `files`               | Exactly three entries: `main.js`, `manifest.json` and `styles.css`                 |
| `files[].name`        | The file name                                                                      |
| `files[].size`        | The number of bytes in the file, an integer from 0                                 |
| `files[].sha256`      | SHA-256 of the file's bytes, 64 hexadecimal characters in lower case               |
| `files[].content`     | The file's bytes in base64                                                         |
| `signature.algorithm` | The string `ECDSA-P256-SHA256`                                                     |
| `signature.keyId`     | The identifier of the signing key, 16 hexadecimal characters                       |
| `signature.value`     | The signature in base64: raw IEEE P1363 form, `r` followed by `s`, 64 bytes in all |

`pluginId` and `releaseName` match `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`. They therefore hold no character which JSON escapes, and the canonical form is the same in every JSON implementation.

Base64 is the standard alphabet with padding (`=`) and without line breaks. A string is accepted only if it is exactly what encoding the decoded bytes produces.

## The release number in the build

Every build carries its release number as a literal marker in `main.js`: the text `livesync-security-release:<n>`, where `<n>` is a positive decimal integer without leading zeros, for example `livesync-security-release:11`. A package is valid only if its `main.js` holds the marker exactly once and the number equals the package's `releaseNumber`. A package can therefore not state another number than the build inside it carries.

The marker is searched for in the bytes of the file. Every occurrence of the text `livesync-security-release:` counts, also one which no number follows. The number is all the digits which follow the text directly.

The number comes from `releaseNumber` in `security-release.json`. The build passes the complete marker to the source as one constant, which the source refers to in exactly one place, and code which needs the prefix derives it from that constant when it runs. A production build fails unless the built `main.js` holds the prefix exactly once, followed by exactly the declared number; `scripts/security/verify-release-marker.mjs` performs that check in the build, in continuous integration and in the release workflow. The release workflow also refuses a tag which is not `<manifest version>-security.<releaseNumber>`.

A running plug-in exposes its number as `securityRelease.releaseNumber` on the plug-in object, beside `securityRelease.loadState`, which is `loading`, `loaded` or `failed`. This property is part of the installation protocol: the build which installs a package reads it from the instance of the build it has just loaded.

## Synthetic example

The key of this example was made for this document and is trusted nowhere. Its `main.js` is nothing but a comment which holds the marker, and its `styles.css` is empty, to show what an empty file looks like.

```json
{
    "format": 1,
    "pluginId": "example-plugin",
    "releaseName": "0.0.1-security.3",
    "releaseNumber": 3,
    "files": [
        {
            "name": "main.js",
            "size": 31,
            "sha256": "269f4382a3d0dca6b55c75847edff3a5c5ccf723ebf063c6a610afc58e9b0e24",
            "content": "LypsaXZlc3luYy1zZWN1cml0eS1yZWxlYXNlOjMqLw=="
        },
        {
            "name": "manifest.json",
            "size": 23,
            "sha256": "48543805009edaca498442cd13e278477221e48ad5c7974cdabdb13d9a8ca022",
            "content": "eyJpZCI6ImV4YW1wbGUtcGx1Z2luIn0="
        },
        {
            "name": "styles.css",
            "size": 0,
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "content": ""
        }
    ],
    "signature": {
        "algorithm": "ECDSA-P256-SHA256",
        "keyId": "f1204a3af05cb801",
        "value": "OIWzXwyRrKXqKUVC3wsejqOjF3ljyKWhRCBU0gOeGiUaWIf1Tu3MOkI+gtmK6TdGOHYiz6jr1z1cFwnwaHqN4Q=="
    }
}
```

The public key of the example, as SPKI DER in base64:

```text
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9p+SBc9wBdPIqQifrQmcfYLXq8ohvlPZ3i+oXTa6cdwKu6W140M2gcC7b72nlCBXiBI1/IJuUL8J17LiZElwMg==
```

## What is signed

The signature covers everything except `signature`. The signed bytes are the UTF-8 of `JSON.stringify` of a freshly built object, without indentation:

1. The keys of the top level come in the order `format`, `pluginId`, `releaseName`, `releaseNumber`, `files`.
2. The file entries are sorted by `name`. With the three fixed names the order is always `main.js`, `manifest.json`, `styles.css`.
3. Each file entry has its keys in the order `name`, `size`, `sha256`, `content`.

```js
const canonical = JSON.stringify({
    format: p.format,
    pluginId: p.pluginId,
    releaseName: p.releaseName,
    releaseNumber: p.releaseNumber,
    files: [...p.files]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, content: f.content })),
});
const signedBytes = new TextEncoder().encode(canonical);
```

For the example above the canonical text is this single line:

```text
{"format":1,"pluginId":"example-plugin","releaseName":"0.0.1-security.3","releaseNumber":3,"files":[{"name":"main.js","size":31,"sha256":"269f4382a3d0dca6b55c75847edff3a5c5ccf723ebf063c6a610afc58e9b0e24","content":"LypsaXZlc3luYy1zZWN1cml0eS1yZWxlYXNlOjMqLw=="},{"name":"manifest.json","size":23,"sha256":"48543805009edaca498442cd13e278477221e48ad5c7974cdabdb13d9a8ca022","content":"eyJpZCI6ImV4YW1wbGUtcGx1Z2luIn0="},{"name":"styles.css","size":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","content":""}]}
```

The key is ECDSA P-256, and verification uses WebCrypto:

```js
const key = await crypto.subtle.importKey("spki", spkiBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, signedBytes);
```

A unit test verifies the example with its published key and compares its canonical text with the line above, byte for byte.

## Verification rules, in order

The rules are applied in this order, and the first one which does not hold decides. No file content is decoded before the signature has been accepted.

| No. | Code                                                                           | Rule                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `invalid-json`                                                                 | The file is valid UTF-8 and can be read with `JSON.parse`                                                                                                                                       |
| 1   | `no-trusted-key`                                                               | The device has one or more trusted keys. Without any the feature is off                                                                                                                         |
| 2   | `not-an-object`                                                                | The package is a JSON object                                                                                                                                                                    |
| 3   | `unknown-format`                                                               | `format` is the number `1`                                                                                                                                                                      |
| 4   | `unknown-field`                                                                | The top level has no other keys than the six in the table above                                                                                                                                 |
| 5   | `wrong-plugin-id`                                                              | `pluginId` is a string and exactly the identifier of the verifying plug-in                                                                                                                      |
| 6   | `invalid-release-number`                                                       | `releaseNumber` is an integer greater than 0 and no greater than 2^53 − 1                                                                                                                       |
| 7   | `invalid-release-name`                                                         | `releaseName` matches the pattern above                                                                                                                                                         |
| 8   | `invalid-file-list`                                                            | `files` is a list in which every entry has exactly the keys `name`, `size`, `sha256`, `content` with the right types; `sha256` is 64 hexadecimal characters in lower case                       |
| 9   | `wrong-file-set`                                                               | The names are exactly `main.js`, `manifest.json` and `styles.css`, once each. A missing, additional or repeated name is rejected, and so is anything which is not one of these three names      |
| 10  | `missing-signature`                                                            | `signature` is present and has exactly the keys `algorithm`, `keyId`, `value`, all of them strings                                                                                              |
| 11  | `unknown-algorithm`                                                            | `signature.algorithm` is `ECDSA-P256-SHA256`                                                                                                                                                    |
| 12  | `unknown-key-id`                                                               | `signature.keyId` is the identifier of one of the device's trusted keys                                                                                                                         |
| 13  | `bad-signature`                                                                | `signature.value` is base64 of exactly 64 bytes, and the signature holds for the canonical bytes under the key which rule 12 selected                                                           |
| 14  | `invalid-file-content`                                                         | Each `content` is base64 in the single accepted spelling                                                                                                                                        |
| 15  | `file-size-mismatch`                                                           | The number of decoded bytes equals `size`                                                                                                                                                       |
| 16  | `file-hash-mismatch`                                                           | The SHA-256 of the decoded bytes equals `sha256`                                                                                                                                                |
| 17  | `missing-release-marker`, `duplicate-release-marker`, `invalid-release-marker` | The decoded bytes of `main.js` hold the text `livesync-security-release:` exactly once, and the digits directly after it are a positive integer without leading zeros, no greater than 2^53 − 1 |
| 18  | `release-marker-mismatch`                                                      | The number of the marker equals `releaseNumber`                                                                                                                                                 |
| 19  | `invalid-manifest`                                                             | The decoded `manifest.json` bytes are valid UTF-8 and `JSON.parse` yields a plain object (not null, not an array)                                                                               |
| 20  | `wrong-manifest-id`                                                            | That object's `id` is a string exactly equal to the package's top-level `pluginId`                                                                                                              |
| –   | none                                                                           | `releaseNumber` is greater than the number which the running build carries. A package with the same or a lower number is passed over without a notice                                           |

Rules 19 and 20 are the device's own, after the format's rules 0–18; they run on the already hash-verified bytes of `manifest.json`, so no file content is decoded for them before the signature was accepted.

Rules 14 to 16 are applied to one file after the other, in the order of the package file.

Because rule 18 binds the number of the package to the build inside it, the installed build afterwards carries exactly that number, and the same package is then no longer newer.

A native desktop installation writes the decoded bytes of rule 14 under the three fixed file names. A bootstrap installation stores the complete verified envelope under a locally derived SHA-256 name in its protected runtime directory. No arbitrary path is ever derived from a package.

A rejected package raises a notice which names the file and the code. The notice is raised once for each distinct package content on a device, not at every start: the device remembers the SHA-256 of the package files it has told about. A rejected package is nevertheless verified again at every look, so one which was rejected only because its key was not trusted yet is installed once the key is.

## Finding packages

With the feature on, the plug-in looks at the files with the extension `.livesync-release` when the layout is ready, and again two seconds after such a file was last created, modified or renamed.

- A file above 32 MiB is refused without being read.
- A file which is empty or does not parse may still be arriving. It is read again after 2, 5 and 15 seconds, and rejected only if it still does not parse then. No notice is raised for a file which turns out complete.
- Among several valid packages which are newer than the running build, the one with the highest `releaseNumber` is installed.
- The plug-in never modifies or deletes a package file.

A plug-in writes only in the folder of its own vault. On a device with several vaults, each vault installs its own copy when it is opened and the package is in that vault.

## The native desktop installation

Only `main.js`, `manifest.json` and `styles.css` in the plug-in's folder are ever written, together with their companions `<name>.incoming` and `<name>.previous`. `data.json` and the content of the vault are not touched.

This path is restricted to a desktop host without Capacitor and requires the host adapter's native `fsPromises.rename` or `fs.rename`, together with `getFullPath`. The ordinary vault adapter's `rename` method does not establish this capability: it may refuse an existing destination. Without the native replacement operation, installation stops before staging, queue export, or unloading, and raises a notice. Installed files are never overwritten in place or removed before replacement.

1. **Stage.** The three decoded files are written as `<name>.incoming`, and each is read back and compared by SHA-256. A read-back which is empty, short or different is not accepted: the file is written and read again after 0.2 seconds, three times, and then after 3, 15 and 60 seconds. If it still does not read back, the installation gives up without having changed anything, removes the staged files and raises a notice. This is not a rejection of the package; it is tried again at the next start.
2. **Back up.** The three installed files are copied to `<name>.previous`, read back and compared in the same way. An installed `main.js` or `manifest.json` which cannot be read, or reads as empty, stops the installation.
3. **Wait until idle.** The swap waits, without an upper limit, until no replication is running, no received change is waiting to be stored or written, no change in the vault is waiting to be stored, and, on a mobile device, the app is visible. The plug-in must be idle at two looks in a row, one second apart, with no storage event in between. Nothing is awaited between the last look and the unload.
4. **Unload.** The plug-in unloads itself through the app's plug-in manager, without being recorded as disabled, and waits up to 30 seconds for its own teardown to settle. If the app does not unload it, no file is replaced.
5. **Swap.** `manifest.json`, `styles.css` and then `main.js` are replaced. Each replacement is one native rename over the installed file: interruption leaves either the complete previous file or the complete package file. If a staged file has changed, it is rewritten and verified before replacement. A refused replacement causes restoration; there is no fallback to writing an installed file in place. `main.js` is replaced last, so until it is in place the previous executable remains. All three are then read back and compared with the hashes of the package.
6. **Load and check.** The app reads the manifests again, if it offers that, and loads the plug-in. The result is accepted only if a plug-in instance exists, is not the instance which was unloaded, has finished loading within 60 seconds, and reports exactly the package's release number.
7. **Otherwise restore.** When a file could not be put in place, or the new build was not accepted, whatever was loaded is unloaded, the package is remembered on the device so that it is never tried again, and the previous files are restored, `main.js` first. Each previous file is written to its staging path, checked against the hash taken when it was backed up, and atomically replaces the installed file. The previous build is loaded and checked in the same way.

The `<name>.previous` files stay beside the installed ones. The swap unloads and loads the plug-in through the app's transient `unloadPlugin` and `loadPlugin`, the pair the app's own reload uses; it deliberately avoids `disablePlugin`/`enablePlugin`, which persist the plug-in as disabled in the app's configuration. Were those used, a crash in the window between the unload and the paired load would leave the plug-in recorded as disabled, so the next start would load no build at all. With the transient pair the persisted enabled state is left untouched, so a crash in that window leaves the plug-in enabled and the next start attempts to load the executable on disk. `unloadPlugin` and `loadPlugin` are required; where the app does not offer them, nothing is installed, and a notice says so.

From the moment its unload begins, the unloaded instance starts no replication, processes no change in the vault and writes no received change to storage, whatever timer or listener of it still fires.

### Outcomes

Every outcome raises a notice. Notices about anything but a successful installation stay until they are dismissed.

| Outcome                                                                | State afterwards                                                               | Tried again                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| Installed                                                              | The new build runs; the previous one is in `<name>.previous`                   | Not needed                   |
| Package rejected                                                       | Nothing was written                                                            | Verified again at every look |
| Package not newer                                                      | Nothing was written, and no notice is raised                                   | Verified again at every look |
| A staged file or a backup does not read back                           | Nothing which the plug-in uses was changed                                     | At the next start            |
| The app cannot unload and load a plug-in                               | Nothing was written                                                            | At the next start            |
| The app did not unload the running build                               | No installed file was replaced. Restart the app if synchronisation has stopped | At the next start            |
| A file could not be put in place                                       | The previous files are back and the previous build runs                        | Never, on this device        |
| The new build did not load, did not finish, or reports another release | The previous files are back, byte for byte, and the previous build runs        | Never, on this device        |
| The previous build could not be started again either                   | The plug-in is not running. Reinstall it by hand                               | Never, on this device        |

## Reporting the running build

Each device writes the build it runs into its entry of the remote milestone, `node_info[<node id>]`, beside the versions it already reports there:

| Field                   | Value                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_main_js_sha256` | SHA-256, in lower-case hexadecimal, of the executable payload bytes which this instance loaded; with the bootstrap this is the package's main.js, rather than the permanent loader |
| `plugin_release_number` | The release number which the running build carries                                                                                                                                 |

A change of either value is written with the next synchronisation, like any other change of the device's entry, so the first synchronisation after an installation reports the new build. The entry is the device's own statement about itself, which anyone able to write the remote can change: it tells the operator what a healthy device reports it is running, and proves nothing about a device which has been compromised, since such a device, or whoever controls the remote, can write any value. Another device, or anyone who can read the remote, can compare the hash with the checksums published for the release. The milestone is not encrypted; the hash of a published build is not a secret. A locked remote does not have its milestone rewritten, as before.

## What this does not protect against

- **The app being closed during native desktop installation.** Each atomically replaced file is complete, but interruption between replacements can leave files from both builds in the folder. Interruption after replacement and before the load check can leave a candidate which has never been accepted. The installer does not run before Obsidian loads `main.js`, so its `.incoming` and `.previous` companions cannot automatically recover a build which fails to load at the next start. Close the app and reinstall a verified release by hand if it does not load.
- **A build which loads but misbehaves.** The check after the reload establishes that the new build loaded and which release it is, not that it synchronises correctly.
- **Anyone who can write the plug-in's folder.** Such a party can replace `main.js` or the trusted keys directly. The signature protects the path from the content of the vault to running code, not the folder itself.

## What the storage layer enforces

Before this feature, nothing kept a synchronised document out of the plug-in's folder except that the folder's files do not normally appear in the vault and so are not written back. That was a property of ordinary use, not a rule the code enforced: a document whose path named a hidden location, in a spelling the vault index did not hold, was written straight to the file-system adapter. A build without the change below does not enforce the rule, and its security argument rests only on that ordinary-use property.

With the change, the plug-in's own storage layer enforces two rules on every route by which a synchronised document can create, write, append to, remove, or make a directory, and on the vault-API routes which create a file or rename one to a path the index does not yet hold:

- The trust file is refused outright (the write-protection guard above).
- No path may reach a folder or file which exists on disk by a name which that folder does not list. Names are compared without regard to case and Unicode normalisation only, which are the differences the supported file systems fold by design; a short name such as `OBSIDI~1`, a trailing dot or space, or an ignorable code point is not a listed name, so a document cannot reach a hidden location, or the trust file, under such a spelling. A symbolic link or junction is listed under its own name and is not treated as an alias.

A document with a genuine dotted path (`.obsidian/...`) is a separate matter: Hidden File Sync treats such paths as its own, and they are governed by its target rules, not written back as ordinary documents. The alias rule exists to stop a non-dotted spelling of such a path from slipping past those rules.

- **A signing key which is lost or misused.** Every package signed with a trusted key and carrying a higher release number is installed without confirmation. A key is withdrawn by removing it from the trust file on each device.
- **Downgrades by hand.** The release number only ever has to rise for packages. Installing an older build by hand makes packages newer than it valid again.

## Permanent bootstrap for mobile storage

The mobile adapter's rename operation can delete its destination before renaming the source. Overwriting main.js in place or deleting it first could therefore remove the code needed for recovery. A permanent loader avoids this operation entirely. It is installed locally once, while Obsidian is stopped, and is never replaced by the vault update channel.

A production build additionally produces bootstrap.js, bootstrap-styles.css, bootstrap-baseline.json and bootstrap-installation.json. The latter lists the exact SHA-256 and relative target of each installation artefact. Install bootstrap.js as the root main.js, the normal manifest as manifest.json, the inert bootstrap-styles.css as styles.css, and the baseline envelope at release-runtime/<baseline-sha256>.livesync-release. The permanent loader injects the verified payload CSS itself, so the stable root stylesheet contains only a comment and applies no styles. The baseline is an installation artefact authenticated by the hash compiled into bootstrap.js; it is not a new signed update format. Install the trusted public keys by the existing local route. Preserve data.json. Verify the published SHA256SUMS and every installed target before starting Obsidian. The normal main.js and styles.css release assets remain payload files, and must not be mistaken for the permanent loader files during this initial installation.

Future packages keep signed format 1. The running build verifies the signature, id, release number and all three files. The bootstrap verifies the original signed envelope again before staging it under its unique package SHA-256 in release-runtime. Staging alone does not activate it. After the normal quiet checks, the old build unloads, its teardown settles, and an immutable intent record authorises the staged package. Root main.js, root manifest.json and root styles.css are untouched by this path.

At startup, the loader authenticates the pinned baseline and accepted local packages by their recorded package hash. A new intent is eligible only when it names a known accepted previous build and the new package passes verification against the device-local trusted keys available when the intent is evaluated. Before evaluating it, the loader writes and reads back an attempt record. It evaluates the verified CommonJS main.js with the require supplied by Obsidian, constructs a real Plugin child, waits for loading and installs the verified CSS. Only then is an accepted record persisted. Records use fixed fields and unique hash-bound names; a torn record is ignored. New records never replace a previous complete record with different contents.

An attempted package without an accepted record is not executed again at the next start. On a normal loading failure the child is cleaned up, its startup and teardown are awaited, and the previous accepted payload or pinned baseline is loaded. Protocol 1 requires the same durable queue format across payloads, so fallback never depends on an export implemented by rejected code. The legacy queue export remains part of the native desktop downgrade path. A cleanup which fails or does not settle blocks recovery in that process. Its pending cleanup remains alive to drain resources if startup eventually resumes; no previous payload starts while teardown is unresolved. The root loader remains available even when a candidate cannot compile. A synchronous infinite loop cannot be interrupted by a timer on the same JavaScript thread; after restarting the app, its pre-existing attempt record causes fallback.

Protocol 1 payloads must expose waitForStartup and waitForTeardown as awaitable ownership boundaries; a candidate missing either is refused before onload. Even on a host whose child load method returns void, the loader owns startup until waitForStartup settles. Cancellation invalidates the generation and aborts the status poll, clears its timer, and retains the child until late startup and teardown settle. Late startup is followed by another unload sweep to remove resources registered after the first unload. A synchronous unload exception or unsuccessful teardown permanently blocks fallback in that facade.

The host registers the loader facade. The facade exposes the child through the explicit releaseRuntimeInstance boundary, forwards core/status and host lifecycle hooks, and owns the selected CSS. The installation host unwraps this boundary for its instance checks. The payload manifest retains the root plugin directory so data.json and all normal settings paths remain unchanged. The running version and release number refer to that payload. The manifest on disk identifies the initial bootstrap installation; the remote milestone is the operational source for the currently running payload hash/release.

Every writer, append, rename and removal route used by synchronised documents protects the entire release-runtime subtree in addition to the installed root files and trust anchor. Local accepted metadata is an execution trust anchor and must never arrive through synchronisation. The bootstrap and signing code never take a trusted key from a package. Removing the key file stops new activation; an already accepted locally authenticated payload and the baseline can still start.

Verify every managed vault independently. Treat the initial bootstrap installation and activation of a subsequent higher signed payload as separate verification steps. Test invalid signatures and content, load failure, cleanup, reload and process termination around each record boundary. Compare plugin_main_js_sha256 with the published checksum for the payload main.js; it identifies the executable payload, not the permanent loader.

For manual recovery, stop Obsidian first and retain the existing runtime directory as recovery evidence. Install a complete newly verified bootstrap/baseline set into a fresh runtime directory, verify the installation descriptor and preserve data.json and the locally trusted keys. Copying three older ordinary plugin files over a bootstrap installation is not a supported rollback: it bypasses the runtime and queue protocol. The native desktop installation continues to use its own documented atomic replacement path.
