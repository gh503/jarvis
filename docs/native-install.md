# Per-user native integration for portable packages

macOS and Windows portable packages include `scripts/install-native.ts`. This creates shortcuts pointing to the **existing extracted package directory**. It does not copy the package, update a running runtime, require administrator privileges, start Jarvis, or change Linux desktop/systemd integration.

Extract a trusted native package into a permanent, writable location first. Keep that directory in place: shortcuts contain absolute paths to its bundled Node runtime and `scripts/app.ts`. Moving, renaming, or deleting the directory breaks them. Use the package matching the operating system and CPU architecture.

## Commands

Run from the extracted package directory, using its bundled Node 24 runtime.

macOS:

```sh
./runtime/node --experimental-transform-types scripts/install-native.ts --install
# Optional: also start the server, without opening a browser, at the next login.
./runtime/node --experimental-transform-types scripts/install-native.ts --install --autostart
# Remove integrations, preserving the package and application data.
./runtime/node --experimental-transform-types scripts/install-native.ts --uninstall
```

Windows PowerShell:

```powershell
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\install-native.ts' --install
# Optional login startup:
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\install-native.ts' --install --autostart
# Uninstall integrations:
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\install-native.ts' --uninstall
```

Choose one install command. Existing integrations are never silently overwritten: uninstall before reinstalling, enabling/disabling startup, or pointing shortcuts to a different package or config file. Missing or ambiguous actions and unknown flags fail. `--autostart` and `--config ABS` are valid only with `--install`; they can be used together. `--uninstall` rejects both options.

## Optional private external configuration

Use the recommended [v2.0.47 unsigned preview](https://github.com/gh503/jarvis/releases/tag/v2.0.47) for this optional binding. Installation without `--config` keeps the existing behavior.

To bind shortcuts and optional login startup to a private config file outside the portable package, add `--config` with its canonical absolute filename:

```sh
./runtime/node --experimental-transform-types scripts/install-native.ts --install --autostart --config /absolute/private/jarvis.env
```

```powershell
& '.\runtime\node.exe' --experimental-transform-types '.\scripts\install-native.ts' --install --autostart --config 'C:\absolute\private\jarvis.env'
```

The launcher also accepts `--config ABS`, including with `--no-open` or `--stop`. For example, stop the instance selected by that configuration before a manual upgrade:

```sh
./runtime/node --experimental-transform-types scripts/app.ts --config /absolute/private/jarvis.env --stop
```

For direct runtime use, `JARVIS_CONFIG_FILE` selects the same file; the launcher's explicit `--config` takes precedence over that inherited selector. The file must exist and pass validation; an empty or invalid selector fails rather than falling back to the package's `.env`.

Use UTF-8 text of at most 64 KiB, with one recognized `JARVIS_*` configuration assignment per line. Blank lines and lines starting with `#` are allowed; optional matching single or double quotes surround literal values. There is no shell execution or variable expansion. Duplicate keys, unknown keys, generic environment variables such as `PATH` or `NODE_OPTIONS`, invalid UTF-8, and NUL bytes are rejected. This is a finite allowlist of Jarvis settings, not a general environment loader; even `JARVIS_CONFIG_FILE` is a selector, not an allowed file entry.

`JARVIS_DATA_DIR` is required and must be an explicit absolute path. Every supplied nonempty path setting must also be absolute, including executable overrides such as `JARVIS_PYTHON` and `JARVIS_FFMPEG`; do not use `~`, `$HOME`, relative paths, or bare executable names for these overrides. Omitted settings retain the existing defaults, including bare command fallbacks such as `python3`/`python`, `ffmpeg`, and `arecord`. The file's recognized settings plus defaults replace inherited values for all recognized configuration keys, and the package-local `.env` is skipped. Other inherited process environment is not a sandboxed or fully cleared environment.

A minimal file is:

```dotenv
JARVIS_DATA_DIR=/absolute/private/jarvis-data
```

On Windows, use an absolute Windows path as the value, for example `JARVIS_DATA_DIR=C:\Users\YourName\JarvisData`. Put secrets in the private file, never in command-line arguments. Generated integrations carry only the config filename; the ownership receipt records the config filename and selected data directory alongside its existing integration metadata, not config contents or secrets.

### Create and protect the file

The config filename must be canonical and absolute, with no symbolic links in it or its ancestor directories. The file must be regular and have exactly one hard link. Windows reparse points are rejected. Both the file and its immediate parent must be private. Validation checks permissions without repairing them.

On POSIX, both must belong to the current user with no group or other access. Use mode `0700` for the parent and `0600` for the file. For a **new** directory under your home, these commands create the private location before editing:

```sh
mkdir -m 700 "$HOME/.jarvis-private"
(umask 077; touch "$HOME/.jarvis-private/jarvis.env")
chmod 600 "$HOME/.jarvis-private/jarvis.env"
vi "$HOME/.jarvis-private/jarvis.env"
chmod 600 "$HOME/.jarvis-private/jarvis.env"
```

If the directory already exists, inspect its ownership and permissions before using it. Replace the example data directory in the file with your actual absolute path. Pass the real canonical filename to `--config`; a home path reached through a symlink is not accepted. Keep editor backup and temporary files private too, and recheck permissions after an editor replaces the file.

On Windows, prepare a private directory **before** creating the UTF-8 file, then verify the DACL on both the directory and the file. Allowed access entries are restricted to the current user, SYSTEM, and Administrators, and the current user must have read access. Ownership must be the current user (or Administrators for an elevated current user). A directory inside your user profile does not by itself guarantee an acceptable file ACL: inherited entries, editor-created replacements, and explicit file permissions must be checked. Use your trusted Windows permissions tooling to establish and verify these requirements; the installer will refuse an unsafe file or parent rather than change its ACL.

Windows owner validation is aligned across external configuration and native private-directory handling, including tests under an actual elevated Windows token. This does not relax private-permission requirements or repair permissions during validation.

The binding is an editable config **path**, not an immutable digest pin. The file is validated again when loaded; edits affect subsequent launches, not an already running server. Review changes to `JARVIS_DATA_DIR` especially carefully: a later `--stop` using the edited file selects the newly configured directory. Binding a file does not activate a staged update, switch releases, snapshot data, or establish schema compatibility.

For config recovery, v2.0.47 includes the private [config-only snapshot CLI](native-config-snapshot.md). It preserves exact bytes without mutating the process environment and restores only to a fresh private directory with the same `JARVIS_DATA_DIR`. Snapshot creation requires the source config parent and data directory to be disjoint in both directions. Existing explicit config binding can place a validated config inside the data root, but that layout is unsupported by config snapshot creation. Config and data captures are separate operations, not an atomic pair, full rollback, or automatic activation; external TLS files, models, and installer integrations are not captured.

## What is installed

On macOS, `~/Applications/Jarvis.app` contains a shell launcher and an Info.plist. Open it from Finder to start Jarvis and open its browser window. The launcher changes to the package directory and executes absolute, shell-quoted runtime and script paths. With `--autostart`, `~/Library/LaunchAgents/org.jarvis.portable.plist` contains an XML-escaped `ProgramArguments` array and `RunAtLoad`; it calls the packaged launcher with `--no-open`. The installer does not run `launchctl` or load the agent into the current session. Startup takes effect at the next login and is not a supervised restart service.

On Windows, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Jarvis.lnk` points directly to the bundled `node.exe`. With `--autostart`, another shortcut is written in that directory's `Startup` subdirectory with `--no-open`. Windows PowerShell with `Add-Type` and the Unicode `IShellLinkW` COM shortcut API must be available. A fixed PowerShell program compiles a small fixed C# interface and receives paths and quoted argv as environment data; package paths are never interpolated into PowerShell or C# code. The Unicode API avoids WScript.Shell target-setting failures for paths outside the Windows ANSI code page. Windows may show a console window for the Node launcher. A browser is required for the UI.

Both integrations use the package directory as their working directory. Without an external config selector, configuration retains the existing package-local `.env` and inherited-environment behavior. With `--config`, the generated launcher arguments persist the explicit private config filename and the package-local `.env` is skipped. The installer does not persist arbitrary command-line environment overrides. Spaces, Unicode, shell metacharacters and apostrophes are supported. NUL and line breaks are rejected in integration paths.

## Windows notifications

Explicit Windows installation also registers Jarvis's own per-user toast identity, `org.jarvis.portable`, by setting `System.AppUserModel.ID` through `IPropertyStore` on the generated shortcuts. It never borrows the PowerShell application's identity. The existing ownership receipt records the identity and shortcut hashes; uninstall removes the owned shortcuts under the same hash checks. Older installations must be explicitly uninstalled and reinstalled to enable this feature.

Sending requires system Windows PowerShell, the receipt, and an unchanged Start menu shortcut. PowerShell rechecks the actual shortcut AUMID before using WinRT. Discovery does not register anything or send a notification. Title/body are bounded Unicode text supplied only through environment variables and XML text nodes; notification content is not logged on failure. Toasts have no click actions. The process is hidden, shell-free and time-limited. `JARVIS_NOTIFY=0` disables delivery; the custom notification-command override remains available on Linux/macOS but does not replace Windows's fixed sender.

Windows notification settings, Focus Assist, organization policies and desktop/session availability can suppress delivery. A discovered identity is not proof of a displayed banner. Native CI validates the production XML serializer, WinRT toast construction and shortcut AUMID without sending a toast; banner delivery and permission remain explicitly unverified. No local desktop notification is sent by the automated tests.

## Verification, updates and uninstall

Before installation, the manifest must match the platform, CPU architecture and Node 24 runtime metadata. Every listed payload file is checked for size and SHA-256, paths must remain within the package, and symlink payloads are rejected. Runtime, launcher, native installer and server entry point must be listed. This catches corruption; it does **not** authenticate an attacker-modified manifest. Verify the downloaded release archive's published SHA-256 through a trusted channel before executing any included runtime or installer. Validation cannot protect the installer before it is first executed, nor protect a package modified after installation.

There is no install-time copy or in-place updater. For manual upgrades, stop Jarvis using the existing launcher's `--stop` command with the same config selection used to launch it, uninstall the old integrations, extract and verify the new package in a separate stable directory, and install its integrations. If using an external binding, explicitly supply `--config ABS` again at installation; uninstall does not take that flag. Review production data compatibility and recovery before launching a new release against existing data; see [Native update staging and recovery](native-update.md). Never extract a release over a running package. The installer itself leaves running servers alone, including during uninstall.

For data recovery, v2.0.47 includes the offline [data-only snapshot CLI](native-state-snapshot.md): stop the runtime and all other writers, create and verify a snapshot, then restore only to a fresh directory. It preserves original secrets and application SQLite WAL within the selected data tree, subject to the documented root coordination-file exclusions. External config, external paths and installer integrations are not captured; restoration neither activates a release nor proves schema compatibility.

Released in v2.0.47, [native recovery sets](native-recovery-set.md) bind a verified baseline package identity to private config and data snapshots captured sequentially under one continuously held stopped-data scope. The aggregate captures baseline identity and child manifest digests, not installer integrations or a copy of the bundle. Verification requires the original baseline package to remain unchanged and available at its recorded path. This adds no schema compatibility guarantee, recovery-set restore, or activation command.

An ownership receipt is kept at `~/Library/Application Support/Jarvis/native-install.json` on macOS or `%LOCALAPPDATA%\Jarvis\native-install.json` on Windows. Uninstall accepts only the known integration paths and removes only files whose hashes still match that receipt. Modified artifacts cause refusal before deletion; inspect them manually rather than deleting user changes blindly. Uninstall without a receipt is a no-op. It removes empty app-wrapper directories but preserves unrelated files, the portable package, configuration, conversations, models, browser profile and all other user data. If you lose the receipt, remove the documented integration files manually after reviewing them. Uninstall does not unload an already loaded LaunchAgent or stop the server; log out to clear the login-session registration.

### Unreleased receipt-validation hardening

Source commit `f28efe2` adds unverified, unreleased hardening with bounded receipt (64 KiB) and artifact (1 MiB each) reads, strict UTF-8 and producer-format receipt validation, and regular-file identity checks before removal. These checks are not included in the recommended v2.0.47 package and remain unverified. The ownership receipt remains mutable local metadata, not publisher authentication. Original package/config/data paths need not exist for uninstall, and missing integration artifacts remain permitted.

On POSIX, files and per-user integration ancestors must belong to the current account and reject group/other write access; the receipt additionally requires owner-only permissions. New integration directories explicitly request mode 0755, subject to umask. Existing unsafe directories are refused without permission repair, including older installations created under a group-writable umask. Windows mode bits do not prove ACL privacy; this change does not add Windows ACL validation.

All available artifacts must pass preflight before removal begins. A later filesystem change or deletion failure can still leave a partial uninstall; the receipt is removed last, but there is no persistent recovery journal or atomic multi-file transaction. This work does not add integration snapshots, automatic rollback, activation, or Windows ACL migration.

### Unreleased installation-failure cleanup

The source installer is also being hardened to track completed outputs by file identity and content digest, rather than by path alone. Failure cleanup removes only outputs that still match those records. Changed, replaced, or uncertain partial outputs are retained for inspection, and one cleanup error must not prevent attempts to clean other verified outputs. The original installation failure and cleanup failures remain reportable together.

These are in-process failure safeguards, not a persistent recovery journal. A crash can still leave partial integrations. Path validation and unlink are separate operations; this is not protection against hostile same-account pathname races, and it does not provide a recoverable version switch or automatic activation.

## Signing and platform validation

These portable packages and the generated macOS app wrapper are unsigned and not notarized. Download quarantine and Gatekeeper can block the wrapper or bundled executable. The installer neither clears quarantine nor changes Gatekeeper policy, signs binaries, invokes an execution-policy bypass, or promises a warning-free first launch. Follow your organization's policy and Apple's supported approval process for software you trust; releases need a separate signing/notarization process for normal trusted distribution. Windows SmartScreen, antivirus or organization policy may also block unsigned downloads or PowerShell COM access.

Automated tests use temporary home/package directories and injected PowerShell execution. On macOS, native CI can syntax-check generated plists with `plutil`; on Windows it creates and inspects temporary `.lnk` artifacts through the Unicode API, then activates a shortcut whose isolated fixture writes a sentinel and exits. That fixture imports no Jarvis application code and starts no browser or server. No test installs into the real user's desktop, Start menu or login directories. Automated artifact checks do not establish Finder launch behavior, actual login startup, browser interaction, Gatekeeper/notarization acceptance, SmartScreen behavior, or machine policy compatibility. Those interactive aspects remain unverified until tested manually on representative native machines.
