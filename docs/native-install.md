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

Choose one install command. Existing integrations are never silently overwritten: uninstall before reinstalling, enabling/disabling startup, or pointing shortcuts to a different package. Missing or ambiguous actions and unknown flags fail. `--autostart` is valid only with `--install`.

## What is installed

On macOS, `~/Applications/Jarvis.app` contains a shell launcher and an Info.plist. Open it from Finder to start Jarvis and open its browser window. The launcher changes to the package directory and executes absolute, shell-quoted runtime and script paths. With `--autostart`, `~/Library/LaunchAgents/org.jarvis.portable.plist` contains an XML-escaped `ProgramArguments` array and `RunAtLoad`; it calls the packaged launcher with `--no-open`. The installer does not run `launchctl` or load the agent into the current session. Startup takes effect at the next login and is not a supervised restart service.

On Windows, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Jarvis.lnk` points directly to the bundled `node.exe`. With `--autostart`, another shortcut is written in that directory's `Startup` subdirectory with `--no-open`. Windows PowerShell with `Add-Type` and the Unicode `IShellLinkW` COM shortcut API must be available. A fixed PowerShell program compiles a small fixed C# interface and receives paths and quoted argv as environment data; package paths are never interpolated into PowerShell or C# code. The Unicode API avoids WScript.Shell target-setting failures for paths outside the Windows ANSI code page. Windows may show a console window for the Node launcher. A browser is required for the UI.

Both integrations use the package directory as their working directory, so a package-local `.env` is resolved there. No command-line environment overrides are persisted by this installer. Spaces, Unicode, shell metacharacters and apostrophes are supported. NUL and line breaks are rejected in integration paths.

## Windows notifications

Explicit Windows installation also registers Jarvis's own per-user toast identity, `org.jarvis.portable`, by setting `System.AppUserModel.ID` through `IPropertyStore` on the generated shortcuts. It never borrows the PowerShell application's identity. The existing ownership receipt records the identity and shortcut hashes; uninstall removes the owned shortcuts under the same hash checks. Older installations must be explicitly uninstalled and reinstalled to enable this feature.

Sending requires system Windows PowerShell, the receipt, and an unchanged Start menu shortcut. PowerShell rechecks the actual shortcut AUMID before using WinRT. Discovery does not register anything or send a notification. Title/body are bounded Unicode text supplied only through environment variables and XML text nodes; notification content is not logged on failure. Toasts have no click actions. The process is hidden, shell-free and time-limited. `JARVIS_NOTIFY=0` disables delivery; the custom notification-command override remains available on Linux/macOS but does not replace Windows's fixed sender.

Windows notification settings, Focus Assist, organization policies and desktop/session availability can suppress delivery. A discovered identity is not proof of a displayed banner. Native CI validates the production XML serializer, WinRT toast construction and shortcut AUMID without sending a toast; banner delivery and permission remain explicitly unverified. No local desktop notification is sent by the automated tests.

## Verification, updates and uninstall

Before installation, the manifest must match the platform, CPU architecture and Node 24 runtime metadata. Every listed payload file is checked for size and SHA-256, paths must remain within the package, and symlink payloads are rejected. Runtime, launcher, native installer and server entry point must be listed. This catches corruption; it does **not** authenticate an attacker-modified manifest. Verify the downloaded release archive's published SHA-256 through a trusted channel before executing any included runtime or installer. Validation cannot protect the installer before it is first executed, nor protect a package modified after installation.

There is no install-time copy or in-place updater. For upgrades, stop Jarvis using the existing launcher's `--stop` command, uninstall the old integrations, extract and verify the new package in a separate stable directory, and install its integrations. Never extract a release over a running package. The installer itself leaves running servers alone, including during uninstall.

An ownership receipt is kept at `~/Library/Application Support/Jarvis/native-install.json` on macOS or `%LOCALAPPDATA%\Jarvis\native-install.json` on Windows. Uninstall accepts only the known integration paths and removes only files whose hashes still match that receipt. Modified artifacts cause refusal before deletion; inspect them manually rather than deleting user changes blindly. Uninstall without a receipt is a no-op. It removes empty app-wrapper directories but preserves unrelated files, the portable package, configuration, conversations, models, browser profile and all other user data. If you lose the receipt, remove the documented integration files manually after reviewing them. Uninstall does not unload an already loaded LaunchAgent or stop the server; log out to clear the login-session registration.

## Signing and platform validation

These portable packages and the generated macOS app wrapper are unsigned and not notarized. Download quarantine and Gatekeeper can block the wrapper or bundled executable. The installer neither clears quarantine nor changes Gatekeeper policy, signs binaries, invokes an execution-policy bypass, or promises a warning-free first launch. Follow your organization's policy and Apple's supported approval process for software you trust; releases need a separate signing/notarization process for normal trusted distribution. Windows SmartScreen, antivirus or organization policy may also block unsigned downloads or PowerShell COM access.

Automated tests use temporary home/package directories and injected PowerShell execution. On macOS, native CI can syntax-check generated plists with `plutil`; on Windows it creates and inspects temporary `.lnk` artifacts through the Unicode API, then activates a shortcut whose isolated fixture writes a sentinel and exits. That fixture imports no Jarvis application code and starts no browser or server. No test installs into the real user's desktop, Start menu or login directories. Automated artifact checks do not establish Finder launch behavior, actual login startup, browser interaction, Gatekeeper/notarization acceptance, SmartScreen behavior, or machine policy compatibility. Those interactive aspects remain unverified until tested manually on representative native machines.
