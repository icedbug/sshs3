# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.97.4] - 2026-11-04

Team Vault payloads are now protected against being swapped for an older copy, and a large set of fixes from a code review: transfers, file sync, jump hosts and smartcards.

### Changed
- **Update sshs3 on every member's machine.** A Team Vault now uses file format 2, in which the encrypted profiles are covered by the vault's integrity check, so anyone with write access to the S3 bucket can no longer put an older copy of the profiles under the current vault file. The first member to unlock an existing team with this version upgrades the file automatically; nobody has to click anything and it does not count as an unsynced change. **Older versions of sshs3 cannot read or sync an upgraded vault** and cannot join one; update everyone at about the same time.
- Team Vault: a vault file in an older format than one already seen on the remote is refused instead of pulled. Profile types that a newer version adds to the vault are kept when you save, and not shown until you update.
- SSH: `SendEnv` is no longer accepted in a profile's extra options or in a synced `~/.ssh/config` block, so a shared or imported profile cannot send your environment variables to a server. Profiles that had it stop sending them.
- Directory sync leaves every symbolic link out, on both sides, instead of copying it as a file or writing through it. They are listed as *symbolic links not synced*.
- SSH auto-reconnect now only runs after a lost connection (exit code 255) or a killed process. A normal `exit` no longer reconnects.

### Fixed
- Copying a file onto itself no longer destroys it ("Source and target are the same file"), including through a hard link or symbolic link on a local disk.
- A failed or cancelled transfer no longer deletes an existing target it never replaced, and a cancelled transfer can no longer leave a truncated or empty file behind (local disk and SFTP).
- A transfer cancelled while the copy is being verified now ends as cancelled instead of hanging. Named pipes, sockets and devices are skipped instead of blocking a transfer.
- SFTP: an error the server reports when a written file is closed (disk full, quota) now fails the transfer.
- Kubernetes: writing a file to a pod reports a failure when the write fails, and terminal output no longer breaks a multi-byte character split across two chunks. The file tail no longer reads one byte too many.
- Directory sync: a file and a folder with the same name are shown as a conflict and skipped, instead of being treated as identical (and, in Mirror mode, deleting the folder's contents).
- Changing the profile sync target now locks sync and drops the old key and settings, so the next automatic push cannot write to the new target with the old key. A cached connection to the old target is dropped as well.
- A saved password is no longer sent to a jump host's password prompt, and key install no longer sends the passphrase or password to prompts that are not its own.
- Profile sync: a profile you saved while a pull was merging is no longer lost, a host key that ssh added to `known_hosts` during a pull is kept, and a pull now reports an error if `known_hosts` keeps changing instead of skipping it silently. Settings and profile files are written atomically, and an unreadable one is kept as `.corrupt` instead of being replaced by defaults.
- The external editor uploads one change at a time, keeps working when your editor saves by renaming a file, uploads a save made just before you close it, and only reloads the tab of its own server (it asks before discarding unsaved edits).
- Smartcards: **Lock** now cancels card loads that are running or queued, so no PIN prompt appears after locking; the FIDO2 PIN is not replayed twice in a row, and a failed start no longer leaves its helper process or temporary folder behind.
- The ssh connection-sharing socket is kept in a private folder instead of the shared temp folder.
- Proxy: a target host with spaces or control characters, and SOCKS5 fields over 255 bytes, are refused instead of corrupting the handshake.
- Several screens could finish an operation after you had cancelled, closed or restarted it (search, port detection, log views, the editor's tail view). The tail text is now capped.
- Terminal zoom reacts to the typed character, so <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>-</kbd> reaches the shell. The Kubernetes sign-in dialog clears the token when it closes.
- Unlocking profile sync no longer freezes the app for a few seconds.

## [0.97.2] - 2026-11-01

The start screen's Quick Connect box uses the same fuzzy search as Ctrl+Shift+G, and profiles you edit are found there right away.

### Added
- The start screen's Quick Connect box now uses the same fuzzy search as **Ctrl+Shift+G**: a few letters of the name, host, folder or system, several words (`prod web`) and `#tag` filters, ranked with the best match first and the matched letters highlighted. **Down** / **Up** pick a match, **Enter** connects to it and **Shift+Enter** opens SFTP. The box is announced as a combobox with a list of options for screen readers, and hovering a match selects it.
- Recent Connections shows six profiles (was four), each with its tags and the time since it was last used.

### Fixed
- Profiles or tags added or edited in Connection Manager are searchable on the start screen right away. Before, they were found only after restarting the app, including when you came back to the start screen with the **Home** button while tabs were open.
- In the Quick Connect box **Left** and **Right** move the text cursor (they jump to the buttons only at the start or end of the text), and the selected match is no longer highlighted while a typed `user@host` is what **Enter** connects to.
- The relative times in the Sync settings now read "5 min ago" instead of "5m ago", and a time stamp from a computer whose clock is ahead is shown as a date instead of "just now".

## [0.97.1] - 2026-11-01

SSH CA: **Detect** fills in the CA settings from the URL, and a company root CA in the OS trust store is now trusted.

### Added
- **Detect** next to the CA URL in the SSH CA settings. For Smallstep Step-CA it reads the OIDC provisioner and fills in **OIDC Issuer URL** and **OIDC Client ID** (you choose if the CA has several). For OpenBao / HashiCorp Vault it checks that the server is usable, finds the SSH secrets engine (the mounts the server lists, plus `ssh` and `ssh-client-signer`), shows the CA key fingerprint so you can compare it with `TrustedUserCAKeys`, and fills in **Vault SSH Secrets Mount**. Vault roles, the OIDC issuer and the client ID need a token and are not detected.
- If a Step-CA uses a private root that this computer does not trust, Detect says so and a **Root CA fingerprint** field appears. sshs3 then downloads the root certificate and trusts it only if its SHA-256 fingerprint matches (the same trust step as `step ca bootstrap`), and saves it in **Custom Root CA Certificate**. Nothing is trusted on first sight and nothing is added to the OS trust store.
- User guide: *Detect (Step-CA)* and *Detect (OpenBao / HashiCorp Vault)* sections, a complete OpenBao / Vault setup example (JWT sign-in against your identity provider, an SSH CA, and a role where the allowed principal is the signed-in user's own name) with the matching sshs3 field values and notes on `root`, extensions, CA key types and a private CA, and new troubleshooting rows.

### Fixed
- A private root CA installed in the operating system's trust store is now trusted by the SSH CA sign-in, the identity provider requests and OpenShift web login. Before, the app used only the roots bundled with Electron, so such a CA was rejected with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` even though `curl` and the browser accepted it. A **Custom Root CA Certificate** still replaces the defaults.
- SSH CA settings: typing a comma at the end of **Default Principals** now works (it was removed as you typed), and the CA you are editing is no longer also shown as a card below the form. Focus returns to its Edit button, or to **Add CA**, when the form closes.

## [0.97.0] - 2026-11-01

SSH Certificate Authority: sign in with your identity provider and get a short-lived SSH certificate instead of long-lived keys.

### Added
- **SSH Certificate Authority (SSH CA).** Sign in with your OpenID Connect provider in the browser, and sshs3 requests a short-lived OpenSSH user certificate from Smallstep Step-CA or HashiCorp Vault / OpenBao. Add one or more CAs under *Settings → Security & Smartcard*. A profile with **SSH Agent** authentication uses the active certificate when **Use active SSH Certificate Authority session** is ticked, in terminals, SFTP, SSH tunnels and *Test connection*.
- Two key sources: an ephemeral Ed25519 key that exists in memory for one login and is never written to disk, or a PKCS#11 smartcard (a YubiKey or any PIV card) that keeps the private key. Under the Global (App Lifetime) PIN policy the smartcard key source also leaves the card unlocked for your other PKCS#11 profiles until you click **Lock All Now** or quit.
- A shield badge in the toolbar shows the user, principals, expiry and time left, with **Log In with SSH CA**, **Renew Certificate** and **Log Out**. Log Out also cancels a sign-in that is still waiting in the browser.
- When your identity provider issues a refresh token, the certificate renews itself about a minute before it expires, without opening a browser (with a smartcard key source the card must be unlocked, otherwise you are asked for the PIN). Without a refresh token, or if the silent renewal fails, you sign in again.
- Every certificate is checked before it is used: it must be a user certificate with principals, inside its validity window and issued for the key sshs3 asked the CA to sign. The sign-in uses PKCE and checks the `nonce` of the ID token, and plain `http` is accepted only when the identity provider or CA is on a loopback address.
- User guide: a new *SSH Certificate Authority (SSH CA)* page covers the identity provider, Step-CA, Vault / OpenBao and `sshd` setup, daily use and troubleshooting. sshs3.com has a new section about it.
- Two or more local shell panes in a tab share one performance bar in the tab header, instead of each sampling and drawing the same machine's metrics. Remote and Kubernetes panes keep their own bar.

### Security
- Linux: the helper that restarts the app after an in-app update no longer runs `$(...)` or backticks that appear in the relaunch arguments.

### Fixed
- Linux: after an in-app update the app is restarted also when the package manager takes longer than a minute to install (a `dnf` install that took 84 s used to outlast the helper). The helper now waits up to 10 minutes, and a failed or cancelled install still stops it.
- The shared performance bar for local shells is labelled **Local**, and its history is kept when you split or close panes.

## [0.96.74] - 2026-10-30

### Changed
- the search button is a magnifier among the quick links
- the search button is an icon button among the quick links
- match the search button to the design: subtle key cap, room before the divider
- shorter search button with a divider and a blue border on hover

## [0.96.73] - 2026-10-30

### Added
- find systems in global search and connect to all of them
- group servers into a system and manage it
- systems in Connection Manager, with Connect all
- a profile can belong to a system
- select several profiles and move or tag them together
- Team Vault folders as rows, with a folder tree beside the list
- actions in the global search (type > to list them)
- global search (Ctrl+Shift+G) for profiles, tabs and user@host
- tags on SSH and S3 profiles

### Fixed
- review findings on systems
- select the name when renaming a system; dim a folder that follows its system
- the search footer and filter fit the action mode
- a Kubernetes terminal is never treated as an empty tab

### Changed
- retake the Team Vault folders screenshot
- boxed search field and square chips in the search palette
- seams for drawing a folder's profiles as a whole
- share the open-profile-in-tab path

## [0.96.72] - 2026-10-30

Electron 45, a second round of fixes from the code audit, and the system libraries the Linux packages were missing.

### Security
- A question that an SSH server asks during login (a verification code, for example) is never shown as a smartcard or security-key PIN prompt any more, so a server cannot get you to type a hardware PIN into it
- Remote Profile Sync: known host keys from another device are compared per host name, also when an entry lists several names, uses a wildcard, or differs only in upper/lower case. Wildcard entries that cover a whole class of hosts (such as `*` or `*.com`) and malformed entries are no longer imported
- Commands the file manager runs on a server (search, tail, Git status) always use the profile's own port, user, jump host and proxy and never stop to ask a question. If the shared connection is gone, a new one is made from the profile instead of connecting to port 22 as your local user

### Fixed
- Linux: the `.deb` now depends on `libasound2` (`libasound2t64` on Ubuntu 24.04) and `libgbm1`, and the `.rpm` on `mesa-libgbm`. Without them the app did not start on a minimal install (`libasound.so.2: cannot open shared object file`)
- Git commit signing with an ECDSA or a security key (FIDO2) now works: such a key is stored the way Git needs it, and a key pasted with the `key::` prefix also updates `allowed_signers`
- Creating a folder over SFTP reports an error such as "Permission denied" instead of looking as if it worked
- A failed start of `ssh` for a remote command no longer ends in an uncaught error
- Linux: if you cancel the password prompt of an update ("Restart to update"), the app is no longer restarted by itself when you close it a little later, and you can try the update again
- Settings: switching "Show as tab" for a Team Vault, or changing the Connection Manager's start tab, is no longer undone by pressing Save in Settings, toggling hidden files or changing the font size
- The dotfiles sync notice no longer takes over `Ctrl+Shift+Arrow`, so you can keep moving between panes and tabs while it is shown
- Tabs and the file manager's folders are saved together reliably (one could overwrite the other), and the app opens even if the saved session cannot be read
- Renaming a folder in Connection Manager: typing a space no longer folds the folder
- Team Vault in Connection Manager: you stay in the folder you were in after creating or editing a profile, and an error (a wrong passphrase when unlocking, for example) is shown as a message you can dismiss, with the unlock form still there to try again. If the list of teams cannot be loaded there is a Retry button
- OpenShift/Kubernetes tree: expanding a cluster or namespace asks for its content once, a refresh also collapses expanded pods, and a failure to share a cluster with the team is shown

### Changed
- Updated Electron to 45 (Chromium 156, Node 24.22)

## [0.96.71] - 2026-10-29

A better Markdown preview, and updated components.

### Added
- Markdown preview: you can now select and copy any text (it could not be selected before)
- Markdown preview: code blocks in common languages (shell, TypeScript, YAML, JSON, Python, Dockerfile and more) are colored, and have a copy button that copies exactly the code
- Markdown preview: links to web pages open in your browser, and hovering a link shows where it really goes; other links (to another file, to a heading, `mailto:`) are shown as plain text instead of looking clickable

### Changed
- Markdown preview: no backticks around inline code, tables have a grid, and task lists show only the checkbox. While you search, code blocks are shown without colors so that a phrase is found even where the colors would split it
- Updated components within their version ranges: Electron 44.10, the AWS SDK, the Kubernetes client, the updater and the build tools
- The terminal now uses the maintained `@xterm/xterm` package instead of the deprecated `xterm` (same version line, no change in behavior)

## [0.96.70] - 2026-10-28

Follow-up to the code audit in 0.96.69, including a fix for a side effect of it.

### Security
- Log lines mask a secret even when it sits where a long line is cut off, and now also mask Team Vault (age) private keys and the signature and token of presigned S3 links
- SFTP: a reply from the server that is cut short is refused instead of giving a damaged file or name, and an entry whose name contains `/` is ignored
- Restored file manager tabs only reuse the saved password or key of their profile while they still point at that profile's server
- If the OpenShift helper folder cannot be created in your home folder, a private temporary folder is used instead of a fixed, shared one

### Fixed
- File manager tabs reconnect automatically again after a restart, with the secrets of their saved profile (0.96.69 stopped saving secrets in the session but did not look them up again)
- Remote Profile Sync keeps the "last used" time of a profile when another device's copy is pulled
- Prompts are not sent to a window that has already crashed or closed
- The `oc` helper is also installed when the fallback folder is used

## [0.96.69] - 2026-10-27

Result of a code audit of the whole app: every finding was checked against the code before it was fixed.

### Security
- A saved key passphrase is only given to ssh's own local key prompt, never to a question a server asks; tunnels refuse an unknown host key instead of answering it with a secret
- Linking a smartcard to Remote Profile Sync no longer stores the master passwords unencrypted when there is no OS keyring; it stops with a clear message instead
- File manager connections no longer write passwords, passphrases or S3 keys to the saved session
- Kubernetes sign-in no longer accepts a kubeconfig path from the UI
- Remote search, file preview and tail can no longer be steered by file names that start with `-`
- Hovering a network path (`\\server\share`) in the terminal no longer contacts that server, which would have sent Windows credentials to it
- Dropping, pasting or `cd`-ing to a file name that contains control characters is refused
- Team Vault only hands a strictly formatted age file to the age tool
- The FIDO2 key manager only lists and deletes SSH credentials, never the key's web passkeys, and no longer runs ykman when the PIN prompt was dismissed

### Fixed
- Remote Profile Sync: local folders are no longer wiped by a pull, fields cleared on another device are cleared here too, and push, pull and compare no longer run on top of each other or leave the device falsely "ahead"
- The sync target keeps its stored credentials when the OS keyring is locked, and an unreadable config is copied aside instead of discarded
- Team Vault: local changes that were not pushed survive an app restart instead of being overwritten by the next pull; tunnels for shared profiles and for profiles with a saved password now get their credentials
- Directory sync into a folder that does not exist yet over SFTP works
- SFTP: large writes are split into packets the server accepts, and a call that was running when the connection dropped is retried
- Kubernetes: symlinks and special files in a pod are skipped by transfers, a write to a pod waits for the pod to finish and reports errors such as a full disk, and an abandoned write no longer leaves a process running in the pod
- Dotfile pools keep file deletions and no longer lose a file that was added at the same moment
- A malformed certificate can no longer hang the app
- Prompts (host key, PIN, transfer conflict, quit, dotfiles sync) no longer hang for ever when the window showing them crashes
- Starting a tunnel when `ssh` is missing or its arguments are invalid now fails with a message and cleans up

## [0.96.68] - 2026-10-26

### Added
- sysadmin details, chain check and host check in the certificate dialog
- View Certificate... in the right-click menu
- human-readable certificate preview in the path hover card

### Fixed
- show smartcard certificate validity as yyyy-mm-dd
- do not reload an idle pane on refocus while a browser sign-in is pending
- code-review findings and light-theme colours for the certificate views
- use a light CodeMirror theme in the light app theme
- always offer AWS SSO sign-in when credentials fail, and reload idle S3 panes on focus

### Changed
- align remaining 2xl radii and a stray pill button
- tighter corner radii and centred badges
- add Tabby to the modern SSH client comparison

## [0.96.67] - 2026-10-25

### Added
- do not self-update Windows copies the NSIS installer did not install
- policy.conf instead of policy.json, plus an annotated example and docs drift test
- machine policy for enterprise deployment (GPO registry / root-owned policy.json)

### Changed
- ship the ADMX/ADML templates and policy.conf.example as a release zip
- Windows installers and updates in the enterprise guide; align the managed-setting note
- make the policy docs drift test work with CRLF checkouts
- native per-machine MSI target and a build-only mode for release.yml
- align SECURITY.md with the FIDO2 PIN memory-cache exception
- add a style lint for the user guide (docs:lint)
- document the v2 page style in the user-guide README
- commit public/sitemap.xml with the generated site paths, document build rules
- fix team-vault callout inside a list and a bare <member> placeholder
- v2 redesign of the user guide, new quickstart

## [0.96.66] - 2026-10-24

### Fixed
- The 0.96.65 release build failed on a test that assumed the FIDO2 startup step also runs on Windows; 0.96.66 contains the same changes with the test corrected.

## [0.96.65] - 2026-10-24

### Changed
- Unlock at startup no longer asks for a smartcard or FIDO2 PIN when the card or key is not plugged in.
- When a terminal, SFTP connection, Remote Profile Sync or Team Vault needs a smartcard or security key that is not plugged in, an "Insert your smartcard / security key" dialog waits for it and gives way to the PIN dialog once it is detected. Cancelling stops the operation instead of falling back to a PIN prompt. (Detecting a FIDO2 key works on Linux only.)

## [0.96.64] - 2026-10-24

### Accessibility and keyboard
- Dialogs move focus in, keep Tab inside, and give focus back when they close (all modal dialogs, including the host key, smartcard PIN and master password prompts, which keep Cancel as the default).
- The file list is a real grid with sortable, announced column headers; the arrow keys, Home and End move between tabs; menus, Settings categories, pod details and the tunnel wizard have proper roles and keyboard navigation.
- Icon-only buttons and form fields have accessible names, error messages are announced, selected states are exposed (theme, tunnel type, folder icon), and clickable areas are at least 24 px.
- The X server mode options can be reached with the keyboard; toggle switches show a keyboard focus ring.

### Fixed
- Pressing Escape on the Team Vault recovery key dialog no longer closes Settings (and the key with it).
- Pressing Enter in the "Add Image" fields no longer saves and closes Settings.
- The Delete item in the file context menu is readable in the Breeze theme.
- Sync failures stay visible until dismissed.
- After saved passwords or S3 secrets can no longer be decrypted (the OS keyring key was replaced or reset), a warning now says how many were lost and that they must be entered again, instead of leaving the fields silently empty.
- Unlocking with `age` no longer waits for ever when `age` fails before writing its output: abandoned output pipes are released (four failures used to hang every file operation) and the wait after `age` exits is limited to 5 seconds.

### Changed
- Deleting a dotfile pool, clearing the clipboard history, deleting a snippet, unlinking the smartcard from sync, stopping an unsaved tunnel, discarding unsaved editor changes and restarting a pod now ask first, with the app's own dialog.
- The window has a minimum size of 1024 × 600; the file manager toolbar wraps instead of clipping.
- Wording: one term (profile), sentence case, no "Please", proper plurals.

## [0.96.63] - 2026-10-23

### Changed
- bump electron from 44.9.0 to 44.9.1 (#64)

## [0.96.62] - 2026-10-23

### Changed
- run the COPR spec tests on an LF copy of the spec

## [0.96.61] - 2026-10-23

### Fixed
- handle CRLF line endings in the COPR spec renderer

## [0.96.60] - 2026-10-23

### Added
- build each release in COPR from deploy.sh

### Changed
- bump zod to 4.6.7
- document the Fedora COPR repository
- bump COPR spec to 0.96.59

## [0.96.59] - 2026-10-23

### Fixed
- address review findings for RPM scripts and COPR spec
- keep /usr/bin/sshs3 on RPM upgrade

### Changed
- add COPR spec that repackages the released RPM

## [0.96.58] - 2026-10-23

### Added
- **Windows file manager.** Clicking the `C:` breadcrumb opens the drive list. **Change Attributes** replaces the chmod dialog on local Windows panes: read-only, hidden, system and archive, optionally for a whole folder tree. The result is checked after it is applied, so a change Windows silently refuses is reported. SFTP, Kubernetes, S3 and Linux keep chmod.
- **Windows shells as administrator.** The cmd, PowerShell and pwsh buttons have a shield that opens that shell elevated in a separate window through the UAC prompt. Declining the prompt does nothing.
- **S3.** When an AWS SSO session has lapsed the file pane offers **Sign in again**, and access-denied and expired-session errors get a clear message.

### Fixed
- **Windows.** **Reveal** and **Browse** in the terminal hover card resolve paths with backslashes, so the file manager opens on the file's folder with it selected.
- **Windows smartcards and security keys.** Keys left in the shared OpenSSH agent by an earlier run no longer skip the PIN prompt, and **Lock** and quit evict the keys sshs3 unlocked. A card's non-authentication keys are removed from the agent instead of being offered first (`agent refused operation`). Loading two modules for the same card no longer evicts the keys the first just added.
- **S3 behind a proxy.** SSO role credentials no longer hang behind a proxy: they use the profile's proxy and CA settings with timeouts. Only an unambiguous expiry counts as an expired session, so a wrong role no longer asks you to sign in.
- **Re-run with sudo.** The bar now recognises dnf, zypper, yum, pacman, rpm, apt, useradd, systemctl, mount and docker messages, and no longer offers sudo for lines that tell you not to run as root, for lock contention (another apt process holds the lock) or for an application's own "Access denied".

## [0.96.57] - 2026-10-23

The 0.96.56 release build failed on Windows (tests for the new file creation assumed POSIX paths) and was never published, so everything listed under 0.96.56 below ships with this version.

### Fixed
- **New File** names the file rather than the whole path in its "already exists" message on Windows.

## [0.96.56] - 2026-10-23

### Fixed
- **File manager.** After **Compress** or **Extract to Folder**, Enter and the arrow keys now act on the new archive or folder that is highlighted, instead of the row you had clicked before (Enter on a freshly extracted folder used to open the archive in the editor). **New File** now also refuses a name that is a dangling symlink on local disk, instead of creating the file the link points to.
- **Kubernetes profiles.** Signing in again to a cluster and project that already has a saved profile updates that profile instead of adding a second one (existing duplicates are left alone). A project cleared on one machine is now cleared on your other machines at the next sync, and a second window that shows the Kubernetes tree reloads when the kubeconfig changes on disk.
- **Windows.** Closing a window that a terminal was just moved into now asks for confirmation and ends that session, instead of leaving it running without a tab. A saved FIDO2 or smartcard tab in a secondary window now counts when sshs3 decides at startup whether to unlock your key.
- Terminal scrollback (kept for moving a terminal to another window) no longer slows down with very many tiny output chunks.

### Changed
- Dependencies: Electron 44.9.0, `lucide-react` 1.59, `eslint` 10.13, `typescript-eslint` 8.71.2, `@tanstack/react-virtual` 3.14.21, `jsdom` 30.1.3, `ip-address` 10.7.4 and `actions/setup-node` 7 for the build.

## [0.96.55] - 2026-10-22

The 0.96.54 release build failed on Windows (a slow test, not a bug in the app) and was never published, so everything listed under 0.96.54 below ships with this version.

### Fixed
- A file listing test timed out on the Windows build runner; its fixtures are now written in parallel with a longer timeout.

## [0.96.54] - 2026-10-22

### Added
- **Multiple windows.** `Ctrl+Alt+Shift+N` opens a new window on the monitor the pointer is on. Each window keeps its own tabs and layout in the saved session, and window positions are restored (checked against the monitors that are connected). Closing a secondary window asks first when it has live sessions; closing the main window still quits.
- **Move tabs between windows.** Right-click a tab (or use the Menu key, drag it out, or `Ctrl+Alt+Shift+M`) to move it to a new or another window. **Tab Actions** (`Ctrl+Alt+Shift+K`) opens the tab menu for the active tab. Running SSH, local and Kubernetes terminals keep running and show their recent output in the new window; file manager tabs keep both panes. Tabs with unsaved editor changes cannot be moved.
- **Kubernetes sign-in and saved clusters.** The login dialog switches between **Sign in with browser** and **Use a token** and shows only that method's fields. Cluster name, server, TLS option and project are saved as profiles (never the token), can be signed in to again, edited and removed, and a profile limited to one project shows only that project. Profiles sync encrypted like other profiles, and Team Vault can share cluster templates without secrets.
- **File manager: New File.** The toolbar and the empty-area menu create an empty file; an existing name is rejected rather than overwritten.
- **File manager: select by pattern and invert selection.** `Ctrl+S` selects or deselects items matching a pattern such as `*.log`; `Ctrl+Shift+A` inverts the selection.
- **File manager: compress and extract** on local disk and SFTP panes. **Compress to .tar.gz / .zip** creates the archive next to the selection without replacing anything, and **Extract to Folder** unpacks `.zip`, `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2` and `.tar.xz` into a new folder. On SFTP the work runs on the server, so `tar` (and `zip` / `unzip` for zip files) must be installed there.
- **Show hidden files toggle** in the file manager toolbar (eye icon, `Ctrl+H`), so the setting no longer needs the settings dialog.

### Changed
- **File manager sort order** is now folders, dot-folders, files, dotfiles, and stays that way when sorting descending.
- **Cluster server URLs must use https** (plain http only for localhost) and may not contain a user name, password, query or fragment, so a saved, synced or shared cluster can never carry a secret and a token is never sent unencrypted. Entries already stored with such a URL are skipped.

### Fixed
- **Backspace** goes up one folder in the file manager, as the user guide already said. It still edits the search text while a type-ahead search is active.
- The AWS SSO approval dialog now closes when the login ends instead of waiting for Cancel.
- The user guide no longer says that `Tab` switches file manager panes (`Ctrl+Shift+Left` / `Right` does).

## [0.96.53] - 2026-10-21

### Added
- **OpenShift browser sign-in.** In the OpenShift / Kubernetes login dialog, a **Sign in with browser** button (or <kbd>Enter</kbd> in the server field) appears when the entered cluster has OpenShift's built-in OAuth server (OpenShift/OKD 4.13 or newer). It runs the same authorization code + PKCE flow as `oc login --web`: your browser opens the cluster's login page (single sign-on through whatever identity provider the cluster uses), and sshs3 stores the resulting token in `~/.kube/config` just like a pasted one. <kbd>Esc</kbd> or **Cancel** abandons a pending sign-in. Plain Kubernetes, older OpenShift and clusters with direct external OIDC keep the paste flow unchanged. Tested against a mock OAuth server built from the OpenShift source, not yet against a live cluster.

### Changed
- The API token field is no longer marked required when browser sign-in is available; pasting a token still works as before.

## [0.96.52] - 2026-10-21

### Added
- **Go to tab.** `Ctrl+1`…`Ctrl+8` jump to that tab and `Ctrl+9` to the last one.
- **Zoom a split pane** (`Ctrl+Shift+Z`, or the zoom icon in the pane header): shows only the focused pane full-size while the others keep running; press it again to restore the layout. Splitting or closing the zoomed pane also restores it.
- **Close split pane** (`Ctrl+Alt+Shift+W`). Does nothing when only one pane is left.
- **Keyboard shortcut overview** (`Ctrl+Shift+H`) opens *Settings → Keyboard Shortcuts*.

### Changed
- **Terminal shortcuts no longer take keys from the shell or a TUI.** Bare `Alt+<letter>` and `Ctrl+<letter>` reach readline, vim, nano, fzf and tmux as ESC prefixes and control characters, so these defaults moved:
  - Copy Last Command Output: `Alt+C` → `Ctrl+Shift+Y`
  - Re-run Last Command with sudo: `Alt+S` → `Ctrl+Shift+X`
  - Close Tab: `Ctrl+W` → `Ctrl+Shift+W` (as in Gnome Terminal and Konsole)
  - The hardcoded `Ctrl+K` Quick Connect is removed (`Ctrl+K` is kill-line in readline and cut in nano); `Ctrl+Shift+O` opens the same Connection Manager.
  Saved bindings that still equal an old default are replaced by the new default; a binding you chose yourself is kept.
- **Split view bar.** The duplicate split buttons are gone (each pane header has its own). The bare-square Unsplit button is now **Close others** and asks for confirmation when it would end sessions in the other panes.

### Fixed
- **New Remote File Manager shortcut.** Its default `Ctrl+Shift+Alt+F` listed the modifiers in an order that never matches a real keypress, so it did not work from the keyboard. It is now `Ctrl+Alt+Shift+F`, and a saved copy of the old value is migrated.
- Review findings in prompt position tracking and the manual sudo re-run.

## [0.96.51] - 2026-10-21

### Added
- learn the prompt position from the cursor, wider error detection, manual sudo re-run

## [0.96.50] - 2026-10-21

### Fixed
- sudo retry for Rust errno suffix and shells that only send OSC 133 C

## [0.96.49] - 2026-10-20

### Added
- keep the README download counter when old releases are pruned

### Fixed
- attribute host key prompts to the asking host and harden changed-key handling
- confirm a changed host key independently before offering to replace it
- route host key prompts to the trust dialog and handle changed host keys

### Changed
- mention the modern SSH clients covered by the comparison guide
- correct getting-started, Team Vault and connections pages
- correct factual errors in the user guide
- merge KUBERNETES.md into the Kubernetes user guide and correct it
- slim README, add Windows page and system requirements to the user guide

## [0.96.48] - 2026-10-20

### Fixed
- **Re-run with sudo did nothing in shells that send OSC 133 marks.** Bash with the VTE script (`/etc/profile.d/vte.sh`, active when sshs3 is started from a VTE terminal such as GNOME Terminal, which sets `VTE_VERSION`) and fish put the "output starts here" mark on the row after the command. The command was read up to and including that row, so the first output line became part of the command, a line break the safety check rejects, and no suggestion appeared. The command now ends before that row, and a shell that sends no "end of prompt" mark falls back to the row where Enter was pressed.
- **Re-run with sudo did nothing with prompts it did not recognise.** Raw bash (`bash-5.3$`, no rc files), zsh's default (`user@host ~ %`), fish's default (`user@host ~>`) and `(venv) bash-5.3$` were not taken for prompts, so the app never decided that the command had finished and could not find the command on the row. A line now counts as a prompt when the cursor stands after a terminator (`$ # % > ❯ ➜`) and a space with nothing after it, and the command is whatever follows the first terminator on the row where Enter was pressed.
- **The "Re-run with sudo?" bar could be dismissed by the terminal's own replies.** fish asks the terminal for its background colour, the cursor position and the device attributes before every prompt, and xterm.js answers through the same channel as keystrokes, so the answer counted as typing and cleared the bar (and was appended to the line kept for window titles). Replies to such queries (device attributes, cursor position, colour and version replies, focus reports) are no longer taken for input.
- **Re-run with sudo stopped working in a terminal after a shell that sends OSC 133 marks had been used in it.** Once a terminal had seen such marks (fish, or bash with the VTE script), it kept reading every later command from the newest mark, even after you went back to a shell that sends none (`bash` inside fish, `exit` to bash, an ssh session), so it kept returning the old command. A mark is now only used while it belongs to the newest Enter; otherwise the command is read from the row where Enter was pressed.

## [0.96.47] - 2026-10-19

### Added
- **Re-run with sudo.** When a command typed at a prompt fails with a permission error (`Permission denied`, `Operation not permitted` next to a path, `Are you root?`, …), a bar below the terminal shows the whole `sudo <command>`: **Enter** types it onto the prompt (a second Enter in the shell runs it, so you can read and edit it first), **Esc** or any other input dismisses the bar. `sudo` asks for the password in the shell as usual. It works in any shell, with or without OSC 133 prompt marks, follows the dark, light and breeze themes, and goes away if the screen changes so the shown command no longer matches. It is built from the command and its own output, so an older error is never attached to a later command (also not while a nested `ssh` or `docker exec` is running), and a command that wraps over several rows is read in full, also when Enter was pressed with the cursor on an earlier row of it (the tail used to be cut off and ended up in the output). Some shells break a long command line at the right edge themselves, so the terminal does not mark the next row as a continuation; a row filled to the edge is now read as continued by the next one (a row that starts with a prompt never is). It is not offered for shell builtins (`cd`, `source`, `export`, …), commands starting with a `NAME=value` assignment, `ssh`/`scp`/`sftp`/`rsync`/`git`, package tools (`npm`, `pip`, `cargo`, …), commands that already use `sudo`/`su`/`doas`, lines with `;`, `&&` or `||`, redirects to or from a file (`2>&1` and `2>/dev/null` are fine), long output, root sessions, answers to prompts or full-screen programs, PowerShell or cmd. A command containing newlines, control or invisible characters is never offered. Toggle under **Settings → Terminal → Offer to re-run failed commands with sudo** (on by default).

### Changed
- **Fewer false positives from the path hover card.** The card now only opens for a file that exists: text that merely looks like a path (`Node.js`, `example.com`, `and/or`, a file an assistant only proposes) is looked up first and dropped when it is not there. A relative path is only judged when the working directory is reliable (OSC 7, or a local shell's process; not a directory guessed from prompt-like text in the output, which made the card come and go in SSH terminals, and which no longer replaces a reliable one), and a lookup that takes longer than about half a second is ignored so a slow connection never holds the card back. Hostnames, e-mail addresses, version numbers, units (`3.5MB/s`), abbreviations (`e.g`) and capitalized words such as `Version` or `Notes` are no longer linked, and `.env.local`-style dotfiles are. Looking up a path that does not exist (hover, Ctrl+click, editing) no longer logs an `Error occurred in handler for 'storage:stat'` line: a new `storage:lookup` call resolves to nothing for a missing path and still fails for a lost connection or a timeout, in which case the card is shown as before. A card whose lookup finishes after the pointer has left the path is no longer opened. The card no longer closes, flickers or fails to open while output keeps repainting the line under the pointer (xterm reports the link as left and found again on every repaint). A close scheduled when the pointer left an earlier path can no longer close a card shown later. The card is placed relative to where the pointer is when it opens, not where it entered the link, so it no longer lands under a pointer that has moved on and then closes when it settles. An invisible strip around the card's top edge, meant as a bridge from the link, lay exactly under the pointer when the card opened, so the pointer counted as inside the card at once and the card closed when it moved on; it is removed.
- **No misleading path cards while a local shell runs `ssh` (Linux).** The text on screen belongs to the remote host, but the card looked files up and previewed them on this machine, so it appeared only when a file with the same name happened to exist locally. The card is now not offered then (SSH profile terminals are unaffected; `ssh-add`, `ssh-agent` and `sshfs` do not count as a login). It also opens on a fixed side of the pointer, chosen from the room for a card with a preview, so it no longer jumps from below to above the pointer when the preview loads and closes under a pointer that moved into it. The first hover in a local terminal also connects the local storage provider, which fixes `Storage provider not found: local`.
- **Path hover card on Ctrl only.** New **Settings → Terminal → Show the card** option: open the card when hovering (default) or only while Ctrl is held.

## [0.96.46] - 2026-10-18

### Added
- **Search all saved profiles from the start screen.** The quick-connect box now also searches every saved SSH profile (name, host, user, group) and lists the matches; Enter connects to the first one. `user@host` still connects ad hoc, and the SFTP button is greyed out together with Connect while there is nothing to open.
- **Connect on S3 profiles in the Connection Manager.** Opening it from the toolbar showed no Connect button on the S3 tab; it now opens a File Manager tab with the profile in the right pane.
- **New Remote File Manager…** in the **+** menu (`Ctrl+Shift+Alt+F`) opens the Connection Manager on top of a new File Manager to pick the right pane's connection.

### Changed
- **New File Manager opens locally.** `Ctrl+Shift+F`, the **+** menu and the start screen's File Manager card open straight away with Local Disk in both panes instead of asking for a connection first.

### Fixed
- **One FIDO2 touch for a terminal and its path hover card.** The hover card's SFTP channel now shares the terminal's SSH connection (Linux and macOS), so previewing a path no longer asks for the security key a second time. SFTP channels never start a profile's saved tunnels: a refused forward made `ssh` fall back to a brand-new, re-authenticating connection.
- **Path hover card stays inside the window.** Its real height is measured and it is flipped and clamped to the viewport, so tall previews are no longer cut off at the bottom.

## [0.96.45] - 2026-10-18

### Fixed
- **Dropped Windows file names with typographic quotes or `&`/`|`/`<`/`>`/`^` are quoted safely.** PowerShell treats typographic quotes (`‘ ’ “ ”`) as string delimiters, so such names could end the quoting early; they are now quoted literally. A name that needs literal quoting and also contains a cmd.exe metacharacter cannot be pasted safely into both shells and is skipped with a notice.

## [0.96.44] - 2026-10-18

### Fixed
- **Windows terminals: paths and prompts.** Relative names such as `README.md` are now resolved against the real working directory (read from PowerShell and cmd prompts and OSC 7 `file:///C:/...`) and joined with backslashes, so the hover card and editor no longer fail with ENOENT. Absolute Windows paths (`C:\`, `C:/`, UNC) are linked, and `Alt+C` strips PowerShell and cmd prompts.
- **WSL terminals.** Linux paths (`/mnt/c/...`, `\\wsl.localhost\<distro>`) are translated to Windows paths for the hover card, preview, editor, reveal and drag-out. Windows files dropped on a WSL terminal are pasted as `/mnt/<drive>` paths, and the Windows home directory is no longer used as the WSL home.
- **`Alt+C` works on upgraded installs.** A saved `Ctrl+Shift+G` left over from the old default no longer overrides the new `Alt+C` default (a binding you chose yourself is kept). `F12` / `Ctrl+Shift+I` open DevTools again in unpackaged builds.
- **Dropped Windows file names are no longer expanded by the shell.** A path containing `$`, a backtick or `%` is pasted in single quotes (PowerShell literal quoting) instead of double quotes, so a file named like `a$(calc).txt` cannot run a command.

### Security
- Replaced an overlapping-quantifier regex in the custom port-detection validator with a linear check (CodeQL `js/redos`). Behaviour is unchanged: nested quantifiers such as `(a+)+` are still rejected.

## [0.96.43] - 2026-10-18

### Changed
- **Drag remote files from the path hover card more easily.** On SSH and Kubernetes terminals you can now drag the file icon, the preview or the handle (not only click the handle) to start the "Drag out of sshs3" dialog. The preview text can no longer be selected while the card is draggable; use Copy Path or the editor instead.

### Fixed
- **Drop overlay stuck after dragging a local file out of the hover card.** "Drop to Paste File Path" now disappears as soon as the drag ends.

## [0.96.42] - 2026-10-18

### Fixed
- **Windows release build.** Dragging a local file out of sshs3 on Windows rejected backslash paths; the staging name is now taken from the last segment of either separator. The POSIX permission assertions in the drag-out tests are skipped on Windows.

## [0.96.41] - 2026-10-18

### Added
- **Smart terminal paths.** The terminal tracks the shell's working directory (OSC 7 / OSC 133, `/proc` and prompt detection) and recognises file and folder paths in the output, including quoted names with spaces. Hovering a path shows a card with a live peek (first lines or an image thumbnail) and actions: **View/Edit**, **Reveal** in the file manager and **Copy Path**. Ctrl+click still opens the path. Switch it off under *Settings → Terminal → Enable file path hover preview*.
- **Built-in editor and previews from the terminal.** Files open in a CodeMirror 6 editor (syntax highlighting, including HTML/CSS) with rich previews for images, PDF, Markdown, CSV/TSV tables and JSON formatting, working on SSH, local and Kubernetes sessions.
- **Copy last command output (`Alt+C`).** Copies the output of the last command without the prompt lines.
- **Drop onto the terminal.** Dropping files on a local terminal pastes their quoted paths. On SSH and Kubernetes terminals they are uploaded to the current directory and the remote path is pasted (the path the transfer really wrote, e.g. after "keep both"). Files dragged from the file manager work too.
- **Port forward auto-detection.** Web servers and listening ports printed in an SSH or local terminal (Vite, Next.js, Django, Flask, Spring Boot, `http.server`, Go, or your own regex) show a pill with **Forward & Open** / **Open in Browser** and **Retry** after a failure. Configure it under *Settings → Terminal*; it is not offered on Kubernetes terminals.
- **Drag files out of sshs3.** Local files and folders can be dragged from the file manager and from the path hover card into other applications. For remote items (SFTP, S3, Kubernetes) choose **Drag out of sshs3...** in the right-click menu, use the handle on the hover card, or simply drag them out of the window and release; a dialog asks before a temporary copy is downloaded, then shows an item to drag. Copies live in a private temporary folder and are deleted when sshs3 quits; files over 500 MB are not supported.

### Changed
- **Default shortcut for "Copy Last Command Output" is now `Alt+C`** (was `Ctrl+Shift+G`).
- **HTML preview is a static, script-free sandbox** (`sandbox=""`). Scripts, forms, popups and navigation are disabled, and the preview is labelled "Static preview · scripts disabled".
- `transferAdd` now also returns the `targetPath` the transfer writes to.

### Fixed
- Dropping a local file onto the folder it already lives in (rows, pane or breadcrumbs) no longer copies it onto itself.
- Reopening a forwarded port after the first click uses the local port the tunnel was actually created on.
- Terminal links: ALL_CAPS names such as environment variables are no longer treated as files.
- Closing a dirty editor tab asks for confirmation reliably, and external-editor and tail sessions are released when the editor closes.

### Security
- **Previews and editor.** The path hover card does not read credential-like files (`.env`, private keys, `shadow`, `kubeconfig`, `*.pem`, …). Non-regular files (FIFOs, devices) are refused and file reads time out after 30 s of silence. The unused `object-src` was removed from the CSP.
- **Drag and drop.** File-manager payloads dropped on a terminal are shape-checked and names containing `/`, `\` or `..` are rejected. Pasted paths are shell-quoted.
- **Temporary copies.** Staging uses an unpredictable `mkdtemp` folder (mode 0700), never reuses a pre-created path, and only sweeps leftovers owned by the current user. Custom port-detection patterns with nested quantifiers are rejected.

## [0.96.40] - 2026-10-16

### Fixed
- **Linux in-app update privilege reset (`sudo` / `NoNewPrivs`):** Resolved an issue where running `sudo` in the integrated local terminal after an in-app update failed with `The "no new privileges" flag is set`. Prioritized relaunching via `systemd-run --user --slice=app.slice` for all Linux installations (RPM, DEB, AppImage) to spawn a fresh, top-level user session that sheds Chromium's `PR_SET_NO_NEW_PRIVS` flag and dynamically forwards graphical display session variables (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`).

## [0.96.39] - 2026-10-16

### Added
- **Kubernetes log auto-reconnection:** Streaming container logs now automatically recover when containers restart or crash. An exponential backoff timer with a visible countdown reconnects the stream seamlessly. If a pod is deleted and recreated (e.g. by a Deployment rollout or OpenShift DeploymentConfig), sshs3 automatically detects the new replacement pod.
- **Previous container logs (`kubectl logs -p`):** Quickly toggle between live logs and the previous crashed/terminated container instance directly from the log header. If no previous instance exists, sshs3 provides clear guidance and a 1-click shortcut to switch back to live logs.
- **Live CPU & Memory metrics panel:** Added an expandable resource metrics bar in the Kubernetes log view and pod detail modal, displaying real-time CPU (millicores) and memory usage alongside pod resource limits.
- **Restart pod quick-action:** Added a "Restart Pod" action in both the log viewer header bar and the connection tree context menu to easily trigger controller-backed pod re-creation.
- **Dedicated Kubernetes log header:** Restructured the log view with a permanent top header bar (`K8sLogHeader`) so all action buttons (Metrics, Previous, Timestamps, Search, Auto-reconnect, Restart Pod) remain visible and accessible at all times.
- **Kubernetes port-forward auto-reconnect:** Active port-forward sessions now automatically discover and reconnect to replacement pods when pods terminate or roll out, keeping your local listening port open.

### Fixed
- **Linux desktop relaunch:** Ensured reliable app relaunches on Linux under systemd scopes (`app.slice`), preserving active PAM/logind sessions and restoring SELinux contexts for AppImages to prevent `sudo` failures in the integrated local terminal.
- **File manager dropdown alignment:** Corrected Git status and disk space dropdown menus to align properly to the left edge to avoid being clipped off-screen.

### Security
- **Shell argument escaping in Linux relaunch:** Hardened the standalone Linux relaunch script to strictly quote all path variables and AppImage paths using POSIX single-quote escaping, eliminating command injection risks from environment variables or special characters in installation directories.

## [0.96.38] - 2026-10-15

### Fixed
- **Terminal & Kubernetes log links.** Configured xterm's link handler so clicking hyperlinks in terminal panes and Kubernetes log views properly launches the target URL in the default system browser.
- **Breeze theme contrast.** Adjusted the selection background color in the Breeze terminal theme for clearer contrast against dark backgrounds.

### Changed
- **Dependencies & CI.** Updated npm dependencies across AWS SDK, Vite, Vitest, Lucide React, and bumped `actions/setup-node` to v7 in GitHub Actions.
- **Team Vault documentation.** Added an animated architecture video walkthrough to the Team Vault user guide.

## [0.96.37] - 2026-10-15

### Fixed
- **AWS SSO sign-in behind a TLS-intercepting corporate proxy.** The SSO device-authorization calls now trust the system CA store and honor the profile's proxy/custom-CA settings, the same way the S3 client already did, and fail with a visible error instead of spinning forever when the connection hangs.
- **Keyboard shortcut rebinding.** The "press keys to rebind" recorder no longer gets its keystrokes swallowed by the app's own global shortcuts (e.g. recording <kbd>Ctrl+W</kbd> no longer closes a tab in the background), now shows a live preview while a modifier is held, and no longer mangles Swedish/Nordic å/ä/ö into US-layout punctuation.

## [0.96.36] - 2026-10-14

### Added
- **Resizable split panes.** Drag the divider line between split terminal panes and between the left and right file manager panes to customize their sizes. Double-click any divider to reset to equal 50/50 sizing.
- **Quick Connect on landing screen.** Launch an SSH terminal session directly from the start screen by typing `user@host` (or `user@host:port`) and pressing Enter, without creating a saved profile first.
- **File manager breadcrumb & status bar.** The breadcrumb navigation has a dedicated toolbar row with direct path editing via <kbd>Ctrl+L</kbd> / <kbd>Alt+D</kbd>. Each file pane features a bottom status bar showing total item count, filter count, and selected files and size.
- **Cross-source connection search.** Searching in Connection Manager now queries across all sources simultaneously (Personal, Remote Profile Sync, and all joined Team Vaults), badging results with their origin.
- **Unlock all action.** When multiple Team Vaults are locked, an "Unlock all" button in the Connection Manager sequentially prompts for your PIN to unlock all teams in one pass.
- **Settings search & accessible controls.** Instant real-time search across all 11 settings categories in the settings dialog sidebar. Improved keyboard accessibility for settings cards and radio buttons.
- **Team Vault UX improvements:**
  - Clear 3-step guide for enrolling new members.
  - "Promote <member>" quick-action when a vault has only a single admin to prevent accidental lockout.
  - Quick lock/unlock action and sync status badge in the team list overview.
  - Live pre-sync status preview on Push and Pull buttons.
  - "Lock now" button directly in the vault detail view.
  - S3 target configuration editor pre-fills existing non-secret settings.

### Security
- **Strict credential redaction over IPC.** Decrypted S3 target secrets for Team Vaults are completely redacted before crossing the IPC bridge to the renderer, replacing them with a boolean indicator.
- **Linux OS keyring persistence fix.** Unconditionally force `gnome-libsecret` on Linux so encryption keys persist reliably in the Secret Service across restarts, eliminating silent credential decryption failures and `SignatureDoesNotMatch` errors under KDE Plasma 6.
- **Multi-vault store integrity.** Fixed an issue where saving or updating an unrelated vault's configuration could compound double-encryption on other vaults' secrets.
- **Physical smartcard serialization.** Serialized `age-plugin-yubikey` execution through `withPkcs11Lock` to prevent PC/SC concurrency conflicts during multi-vault unlocks.
- **Protection against self-lockout and self-invites in Team Vault.**

### Fixed
- Fixed empty team folders showing in the Connection Manager when switching protocol tabs.
- Fixed TeamProfileTreeList cache not refreshing immediately after "Unlock all".

## [0.96.35] - 2026-10-12

### Added
- **Team Vault: multiple teams, and Windows support.** Belong to several teams at once, each with its own role (admin/member) and its own S3 target — teams no longer have to share one bucket. Teams now show as their own tabs in the Connection Manager next to Personal, each independently shown/hidden, with a pinnable default tab and a background sync indicator. Team Vault now also runs on Windows (previously Linux-only); YubiKey 5 is verified end-to-end, YubiKey 4 doesn't work there yet.
- **Simpler join flow.** An admin shares a one-click "invite" per member (the team ID and S3 target, encrypted to that member's own key) instead of dictating S3 credentials by hand. The new member pastes it, reviews the decoded team/endpoint, and joins — no manual S3 setup and no separate unlock step.
- **Team description.** A free-text, multi-line description admins can set to explain what a team is for, shown on its Connection Manager tab and editable from either there or Settings.
- Sync conflicts (unsynced local edits plus a remote change) now surface a "Get latest" action instead of a passive badge.
- PIN/touch dialogs now say which team an unlock, enrollment, or invite action is for.

### Security
- Closed a header-MAC canonicalization gap where a crafted team name, description, or member id could let someone with only S3 write access (no Vault Key) shift which bytes belong to which field under a still-valid MAC. Closed both at the input boundary and inside the MAC function itself.
- The join flow no longer acts on a decrypted invite blindly — the decoded team and S3 endpoint are shown for review before anything connects, since the encryption proves a message reached the right person but not who sent it.

### Fixed
- A team's remembered identity path wasn't saved when creating it (only when joining), forcing the admin to retype it on every unlock; a migrated install's remembered path could also go stale after the on-disk layout changed.
- "Forget team" failed on a team that had a configured S3 target but no local file pulled yet.
- A backward-compatibility bug in the header MAC could block unlocking an existing vault after upgrading.
- A keyboard-navigation regression in the Connection Manager's "pin as default tab" action.
- A crash on a keydown event with no `key` (dead-key/compose and some IME input).

## [0.96.34] - 2026-10-10

### Added
- **Team Vault: shared connection profiles.** A team shares SSH and S3 profiles (passwords and secret keys included) through an S3 bucket it owns. Each member unlocks with their own YubiKey (via the bundled `age` / `age-plugin-yubikey`). There is no shared master password, and the bucket only ever holds ciphertext. Admins add members by pasting a join-info blob and remove them with one click. A printed recovery key (with a copy button) restores access if every YubiKey is lost. Shared folders are browsed as cards with a breadcrumb, with custom folder icons. Linux and YubiKey PIV only for now. See the new Team Vault page in the user guide.

### Security
- Team Vault integrity: a real MAC over the access header, which also covers pulls made while the vault is locked. A pull rejects substituted `ageRecipient` values and injected access-header entries. Push and pull both check the member's identity, and the admin role is enforced in the main process.
- Closed a gap where a pulled file with a shorter member list skipped the access-header MAC check entirely, letting anyone with S3 write access to the vault's path — no member key or YubiKey required — forge a whole new Vault Key and have it accepted as a legitimate member removal. A member removal now also carries a proof tied to the key it replaces, verified before the pull is accepted.
- The pasted recovery key reaches `age` through a FIFO and is never written to a file. YubiKey PIN/touch prompts run through `node-pty` instead of `execFile`. Fixed argument injection in the Team Vault IPC handlers, and folder paths and download sizes are validated and capped.

### Fixed
- YubiKey enrollment is no longer killed during its own management-key migration, and enrolling no longer overwrites the current vault's remembered identity. The touch hint stays visible through long PIN entry and for the whole operation.

## [0.96.33] - 2026-10-07

### Changed
- skip POSIX permission assertions on Windows
- allowlist synthetic secrets in redaction fixtures for detect-secrets

## [0.96.32] - 2026-10-07

### Added
- structured, masked logging with levels, log file and diagnostics

## [0.96.31] - 2026-10-07

### Fixed
- show installing overlay before the blocking installer runs

## [0.96.30] - 2026-10-07

### Added
- **Drives, volumes and free space in the file manager.** Local panes get a drive picker (Windows drive letters, Linux/macOS mounts) with a fill bar per volume; local and SFTP panes show free space for the current folder (SFTP via `statvfs@openssh.com`).

### Fixed
- Windows: quitting now waits for the card eviction and also removes the FIDO2 keys the app loaded from the shared OpenSSH agent (other keys in it are left alone); keys added before a failed or cancelled FIDO2 load are evicted too, and each `ssh-add` eviction is capped at 3 s so an unresponsive agent cannot keep the app from exiting
- Windows file manager: "Up one level" from a top-level folder now goes to the drive root (`C:\`), not `C:`, and a drive root stays on its drive

## [0.96.29] - 2026-10-07

### Fixed
- quitting while a smartcard/FIDO2 PIN dialog is open no longer lets the answer respawn the app ssh-agent or write an agent block into `~/.ssh/config` after the app has shut down
- linking or unlocking Remote Profile Sync with a card whose app agent had died and been restarted no longer carries on with the empty agent's socket; the card is loaded again (with a PIN prompt) instead

### Changed
- internal refactoring with no intended behavior change: the smartcard/FIDO2 agent state and lifecycle moved out of `IpcBridge` into `SmartcardCoordinator` (private state, a small method facade, per-handler-group access), and the smartcard-load cooldown now lives in one place

## [0.96.28] - 2026-10-06

### Fixed
- the test suite no longer fails on Windows hosts (a new test of the FIDO2 startup error message assumed the Linux wording); v0.96.27 could not be built because the Release workflow runs the tests on Windows too

## [0.96.27] - 2026-10-06

### Security
- Remote profile sync: a wrong master password no longer leaves the sync keys cached as unlocked, so a later push cannot overwrite the remote data with a key that cannot decrypt it; the remote state is only recorded as "seen" after a successful decrypt
- a profile's free-form SSH options are now an allowlist of harmless connection options (previously a blocklist that could be bypassed with whitespace in the option name, e.g. `ProxyCommand touch x #`); the same allowlist applies to the `~/.ssh/config` managed block and a block received from sync keeps only the directives sshs3 generates
- a sync pull no longer takes machine-specific fields from other devices (private key path, PKCS#11 library path, agent path, agent identity files, PIN), and the X server path/arguments and smartcard library path settings are no longer pushed or applied
- the smartcard PIN is no longer written to the sync target's configuration, and saved sessions no longer keep a PIN or a proxy password
- saved passwords and passphrases are no longer wiped when the OS keyring is unavailable at startup (undecryptable values are kept as they were); an unreadable `profiles.json` is copied to `profiles.json.corrupt` before it is rewritten
- removed the unused native drag handler, which accepted an arbitrary file path from the renderer, and the unused built-in known_hosts store (OpenSSH has always owned `known_hosts`)

### Fixed
- the file editor opens files over 5 MB, binary files and files that are not valid UTF-8 read-only, so saving cannot overwrite them with a truncated or re-encoded copy
- renaming a file onto an existing name is refused; the SFTP rename fallback no longer deletes the destination first and never replaces a directory
- directory sync: a failing root listing no longer reads as an empty folder (which made the other side look entirely new or extraneous), symlinked folders are skipped and reported, and nothing below an unreadable folder is copied or deleted
- SFTP uploads of empty files now create the file
- automatic reconnect gives up after the configured number of attempts instead of looping when the host is still down, a failed reconnect retries or ends the session instead of hanging, and a reconnected session keeps its multiplexing socket
- remote `git pull` from an SFTP panel works, and remote repositories no longer show as modified
- "Always sync dotfiles" saves the policy on the stored profile instead of runtime values such as the agent socket
- ssh/askpass processes and temporary directories are cleaned up when a connection fails early
- closing the editor after "Tail -f" no longer makes the next file open in tail mode; unsaved Settings edits are kept when settings change in the background (e.g. the font size shortcuts)
- remaining Swedish messages in the transfer queue and key install dialogs are in English

### Changed
- internal refactoring with no intended behavior change: `IpcBridge` is split into per-domain handler modules under `src/main/ipc` (each with a narrow host type), the askpass prompt classification is shared, and `App`, `FilePane`, `ConnectionManagerModal` and `SettingsModal` are split into smaller components and hooks; dead code was removed

## [0.96.26] - 2026-10-06

### Changed
- smartcards with several certificates (e.g. an authentication and a signing certificate on a PIV card) no longer leave every key in the app ssh-agent: only authentication-capable certificates (Key Usage `digitalSignature`; Extended Key Usage `clientAuth`, smartcard logon or any, when present; a certificate that also asserts `nonRepudiation`, like a PIV 9c signing certificate, needs such an Extended Key Usage to count) are attributed to the card, listed in the cached smartcard identities menu and pinned with `IdentitiesOnly`; the other keys are removed from the app agent right after the card is unlocked (Linux/macOS; best effort). If no certificate looks authentication-capable, or the certificates cannot be read, all keys are kept as before, and the key linked for smartcard sync is never removed

### Fixed
- Global PIN caching with a card reachable through two PKCS#11 modules (e.g. p11-kit-proxy and libykcs11): the second module's certificate read broke the PIN login of the card the agent already held, so every signature failed with "agent refused operation" and ssh fell back to a password. Startup unlock now reads every module's certificates before the first card is loaded

## [0.96.25] - 2026-10-05

### Fixed
- the test suite no longer fails on Windows hosts (the app-agent tests assumed POSIX behavior); v0.96.24 could not be built because the Release workflow runs the tests on Windows too

### Changed
- the user documentation text now lives only in `docs/user-guide` (the same pages that are published on docs.sshs3.com); the site repo reads it from this repo when it is built

## [0.96.24] - 2026-10-05

### Changed
- the user guide (`docs/user-guide`) is now entirely in English; it was a mix of Swedish and English
- release tooling: sshs3.com and docs.sshs3.com are published by a new `scripts/deploy-site.sh` (screenshot sync, docs rebuild from this checkout, link validation, commit, push, deploy), runnable on its own; the site deploy also triggers when `ipc.ts` or `settings.ts` change, and screenshots are synced to both `public/img` and `public/img/docs`

## [0.96.23] - 2026-10-05

### Added
- 2D spatial keyboard navigation (Ctrl+Shift+Arrows) across tabs, terminal splits, file manager panes, modals, menus, landing view and unconnected panes; Enter activates, Escape closes/backs out
- local terminals inherit the system/login-shell ssh-agent (setting: Local Terminal SSH Agent)
- saved SSH profiles are kept in the sshs3-managed block of `~/.ssh/config` (setting: Keep ~/.ssh/config in sync; on by default)

### Changed
- **Global (App Lifetime)** PIN caching now keeps every unlocked smartcard and FIDO2 key in **one** app-wide ssh-agent with a stable socket (`$XDG_RUNTIME_DIR/sshs3/agent.sock`) instead of one agent per card. Local terminals always point at it (so a card unlocked later works in already-open tabs), the lock icon makes the agent forget its keys without restarting it, and Remote Profile Sync picks the right card's key. The app's own SSH/SFTP connections through it are pinned to the profile's card with `IdentitiesOnly` and a public key file
- startup unlock loads the PIV card before the FIDO2 key
- under Global PIN caching, unlocked smartcards and FIDO2 keys now also work for a plain `ssh <alias>` in any terminal: a local-only block in `~/.ssh/config` (never synced, removed on lock/quit) points those hosts at the app agent with `IdentitiesOnly` and the card's public key, so no PIN prompt
- a PKCS#11 module that exposes a card already unlocked through another module (e.g. libykcs11 after p11-kit-proxy) is no longer loaded again, so there is no second PIN prompt or PKCS#11 session
- the lock button in the cached smartcard identities menu toggles: **Lock All Now** while something is unlocked, **Unlock Now** when nothing is, so you can unlock again after locking without restarting the app (works regardless of the "unlock at startup" setting)

### Fixed
- Enter/Escape inside a modal were swallowed while the tab bar had keyboard focus
- focus returns to the opener when a top-level modal closes
- keyboard focus in the file manager: Ctrl+Shift+Arrows now actually focus the file list (inactive tabs no longer swallow it, the pane wrapper isn't focusable), and focus stays in the list after opening a folder with Enter
- a FIDO2 key's per-signature PIN prompt through the app agent was labelled "Smartcard / PIV"; it is now a FIDO2 prompt, and the PIN entered when the keys were unlocked is reused for signatures (only the touch is asked for) until the keys are locked
- concurrent `~/.ssh/config` writes are serialized; failures are logged; profile fields can no longer inject extra directive lines

## [0.96.22] - 2026-10-04

### Added
- dotfiles pool manager redesign: pick individual files explicitly, files grouped by target directory with read-only preview, source status (up to date / changed / missing) and Refresh
- unsaved/saved indicator when editing a pool

### Fixed
- dotfile target path keeps the directory (e.g. ~/.kube/config instead of ~/.config)
- device-local dotfile source paths are no longer accepted from remote sync

### Changed
- dotfile pool content is no longer edited in the modal (use Open Master Directory)

## [0.96.21] - 2026-10-04

### Added
- clickable links/paths, snippets, search, copy last output

### Fixed
- address code-review findings and document new terminal features

## [0.96.20] - 2026-10-04

### Added
- encrypted clipboard history for terminal selections
- prune old GitHub releases after a release

### Fixed
- address code-review findings
- never persist history in plaintext
- hide the Ping cell in the performance bar for local shell panes

### Changed
- restore SettingsModal formatting
- refresh README screenshots for the updated Breeze UI

## [0.96.19] - 2026-10-04

### Added
- Overflow ("...") menu for the secondary actions on SSH profile rows in the Connection Manager (install public key, tunnels, duplicate, delete), with arrow-key navigation
- Source | Preview segmented control in the Markdown editor, so the current mode is always visible
- Collapsible "Recently Used" section in the Connection Manager
- Contrast audit tool for the desktop app (`contrast-audit.mjs` in the run-desktop skill)

### Changed
- Denser desktop layout: smaller file-list rows, compact pane toolbars, tab bar, transfer drawer and performance bar, right-aligned tabular numbers, and a shorter "Perms" column header aligned with its values
- Terminal: the redundant single-pane title bar is gone and the performance bar follows the theme in dark, light and Breeze
- Fixed-height Settings and Connection Manager dialogs, so they no longer jump between tabs and categories
- Much stronger contrast in the light theme (borders, text, filled buttons, markdown preview, terminal palette), and stronger text, borders and filled buttons in Breeze and dark
- Softer hairlines between rows and sections via a dedicated divider colour, and a single line under the tab bar
- Top-right notices stack instead of overlapping; "Overwrite" is shown as a destructive action; the host-key and conflict prompts focus the safe option by default
- All dialogs expose `role="dialog"` and accessible names, and `prefers-reduced-motion` is respected (spinners keep turning)

### Fixed
- Escape closed both a dialog and the one underneath it (tunnels, install key, PIN prompts, ...); it now goes to the topmost dialog only, including while a save is in progress
- Several dialogs could not be closed with Escape (new folder, diff, K8s login/debug, sync bootstrap, dotfile pools, master password, SFTP password prompt)
- Undefined colour tokens that rendered nothing (hover borders, some backgrounds) and a focus ring that overlapped field labels
- Markdown preview headings were white on white in the light theme
- Optional sshs3-site deploy in `deploy.sh` now stops on the first failing step instead of reporting success

## [0.96.18] - 2026-10-03

### Added
- add Git & GitHub integration hub and SFTP file manager Git support

### Changed
- update landing and privacy-safe markdown editor screenshots
- clean up internal persona tags from user guide headings
- integrate privacy-safe screenshots, performance metrics, and senior UX guide
- expand user guides with complete field reference, limitations and UI screenshots
- add modular user guides, sync script, CI workflow and PR checklist

## [0.96.64] - 2026-10-24

### Added
- **Git & GitHub / GitLab integration hub (`Settings → Git & GitHub`).**
  - **Developer SSH Keys:** Centralized discovery of public keys across `~/.ssh`, active SSH agents, and unlocked smartcard/FIDO2 hardware caches. Includes one-click copy to clipboard and one-click direct browser registration on GitHub (`/settings/ssh/new`) and GitLab (`/-/user_settings/ssh_keys`).
  - **Cryptographic SSH Git commit signing (`~/.gitconfig`):** Inspect active signing format and key, toggle `commit.gpgsign`, configure signing key with one-click "Git Sign" / "Sign Active", automatically update `~/.ssh/allowed_signers` for local signature verification, and enter custom signing keys.
  - **SFTP & File Manager Git integration:** Automatic Git repository detection in dual-pane file manager panes (local and remote SFTP hosts). Shows branch badge, uncommitted/untracked status, ahead/behind commit indicators (`↑`/`↓`), Git Pull, and "Open in GitHub/GitLab". Includes dedicated toggle switch under *Settings → Git & GitHub* to turn off Git polling and hide Git controls if preferred.
  - **Git Clone:** Clone Git repositories into the active pane folder or selected subfolder with branch selection and shallow clone depth options.
  - **Remote key lookup (`username.keys`):** Inspect and copy public SSH keys from GitHub, GitLab, or self-hosted GitLab accounts.
  - **Dotfiles Git import:** Clone and import dotfiles directly from Git repositories into dotfile pools.
  - **Key Installation with Developer Keys:** Pick public keys directly from local files, active SSH agents, or smartcards when installing keys on remote hosts via SSHProfileForm / InstallKeyModal.

### Security
- **Git clone over SFTP:** the target directory is now shell-quoted in the remote command (previously a directory name such as `x$(cmd)` could execute commands on the server). Control characters in paths are rejected.
- **Git status in untrusted local folders:** git is run with `core.fsmonitor=false`, hooks disabled and no optional locks, so a malicious `.git/config` can no longer run code when browsing into a folder. `.git` files are only followed into `worktrees`/`modules`.
- **Git clone hardening:** URLs and folder names starting with `-` are rejected, `--` separates arguments, `depth` must be an integer, and transports are restricted to https/http/ssh/git. The same protections apply to dotfile Git import and `git pull`.

## [0.96.17] - 2026-10-03

### Added
- **Windows portable data isolation.** Portable Windows builds now detect `PORTABLE_EXECUTABLE_DIR` (or a local `data/` directory) and store user profiles and settings in `<exe-dir>/data` rather than `%APPDATA%\sshs3`, preventing profile collisions with installed copies on the same machine and making USB usage truly portable.
- **Windows Portable ZIP format.** Added `sshs3-<version>.zip` as a pre-extracted Windows target for instant startup without temporary extraction overhead.
- **Single-instance window focusing.** Launching a second instance of sshs3 now brings the existing window to the front and focuses it instead of failing silently or causing profile lock conflicts.

### Changed
- **Windows portable artifact naming.** Portable Windows executables are now explicitly named `sshs3-<version>-portable.exe` on GitHub Releases.

## [0.96.16] - 2026-10-03

### Fixed
- **Last terminal row clipped.** Padding sat on the xterm container, so FitAddon sized the terminal ~16 px too tall and cut off the bottom row (worst on Windows). Padding now lives on a wrapper element, in both the terminal and the Kubernetes log view.
- **Performance bar on Windows.** The non-interactive `ssh` fallback is now limited to login methods that need no per-login prompt, so sampling never triggers a password, PIN or passphrase prompt.

## [0.96.15] - 2026-10-03

### Fixed
- **Performance bar on Windows.** Remote SSH sessions showed "Not connected" because Windows OpenSSH has no ControlMaster socket to reuse. On Windows each sample now uses a short-lived, non-interactive `ssh` connection (key/agent auth; password-only profiles are not supported) and polls at most every 10 s. Latency is measured as TCP connect time to sshd (hidden behind a proxy or ProxyJump). Linux and macOS are unchanged.

## [0.96.14] - 2026-10-03

### Added
- **Performance bar** above SSH, local-shell and Kubernetes terminals. Off by default; enable it under *Settings → Performance*. While it is off nothing is polled.
  - SSH sessions are sampled over the already open ControlMaster connection (no extra login or PIN prompt) with one fixed, read-only `/proc` script: CPU, RAM, load, swap, disk, network, disk I/O, iowait/steal, processes, per-core CPU, cache, all filesystems, uptime and latency. Linux hosts only.
  - Local shells show your own machine (full set on Linux; CPU, RAM, uptime and disk elsewhere).
  - Kubernetes pods use `metrics.k8s.io` (like `kubectl top pod`): CPU/memory against request and limit, restarts, Ready, age and node.
  - Three layouts (text, bars, sparklines), selectable metrics and update interval. Hover for a tooltip with every value; click for up to 15 minutes of history with donuts, bars and stat tiles.

### Fixed
- Prevent double-paste and scroll-to-top when clicking an inactive pane.

## [0.96.13] - 2026-10-03

### Added
- **Update notifications.** The app checks GitHub Releases 30 seconds after start and every 6 hours and shows a banner when a new version exists. Nothing is downloaded or installed until you click *Download* and then *Restart and install*, and the restart goes through the normal quit confirmation (active transfers, confirm before quit). Works for the AppImage and the DEB/RPM packages (DEB/RPM ask for administrator rights). *Settings → App Behavior* has the on/off switch, the current version and a *Check now* button.
- **Air-gap switch.** `SSHS3_DISABLE_UPDATES=1` turns the feature off completely: no network requests, and the setting is locked.

### Changed
- Updates are off on Windows until the installer is code-signed; download new versions from the releases page.

## [0.96.12] - 2026-10-02

### Fixed
- FIDO2 key-file profiles use only their own key
- route remote profile sync through the unlocked smartcard agent
- clear detect-secrets findings, raise src/main/ssh coverage, pin runners to ubuntu-24.04

## [0.96.11] - 2026-10-02

### Added
- **Install public key (ssh-copy-id).** New key icon on every SSH profile row, and an **Access** section in the profile form that works on a profile you have not saved yet. Pick one or more keys (key files, keys already loaded in your ssh-agent, smartcard/FIDO2 keys, or paste one) and they are added to `~/.ssh/authorized_keys` on the host in a single connection, so you enter one password/PIN/touch. Idempotent (reports "installed" / "already present" per key), goes through the profile's jump host/proxy, and verifies key login afterwards when the private key file is unprotected. **Copy command** gives a short, readable script to paste on hosts the app cannot reach, and updates as you change the selection.
- **Access check in the profile form.** A timeline shows where the chain breaks: reach host → host key → login methods → key installed → login works. The first three come from one silent probe that needs no PIN or touch and shows which methods the server allows. It replaces the old Test Connection button, which only validated settings for smartcard/FIDO2. Saving a new key-based profile that was never verified asks first (never blocks).
- **Smart login for the install.** The app never logs in with the key it is installing: installing only a profile's own key uses the password (or a smartcard still configured in the profile, tried first, e.g. after switching PIV to FIDO2) and skips needless PIN prompts. "Log in with" lets you force Password, the profile's key, the smartcard or already-unlocked ssh-agent keys, and the automatic order is shown.
- **New Profile** shortcut on the welcome screen.

### Changed
- **p11-kit is now the default PKCS#11 library** for new smartcard profiles (else the first module found), and the example path is no longer a Net iD library. Install key and Test connection stay disabled until the profile has the library (or key file) it needs.
- Keys already unlocked in the app (global PIN cache) or an open session are read without a PIN or touch.

## [0.96.10] - 2026-10-02

### Added
- **Recursive file-name search in the file manager.** The Ctrl+F filter has a new "Recursive" checkbox that searches names in the current folder and all subfolders (works for SFTP, local, S3 and K8s). Hits show their relative path and open/copy/transfer like normal entries. Capped at 1000 hits / 3000 folders; symlinked folders are never followed, and hidden folders are skipped unless "show hidden files" is on. Rename is disabled while recursive hits are shown, and the filter survives a refresh (it only resets when you change folder).
- **Delete button for saved SSH tunnels** in the global SSH Tunnels menu (asks for confirmation, stops a running tunnel first).
- **Wildcards `*` and `?` in the file filter**, both normal and recursive (e.g. `*.log`, `app-?.txt`). Without wildcards it stays a substring match.

### Fixed
- Proxy passwords are stripped from SSH and S3 profiles in JSON export.
- SFTP stream hardening: guard against overlapping reads, unhandled rejection after protocol init, stderr drain and child cleanup in `createExecStream`, and a 16 MB packet-length limit.
- Memory leak in `TransferQueue` job contexts, async k8s cleanup in `IpcBridge.dispose`, and transfer-progress refresh debounced by 300 ms.
- Security CI: detect-secrets baseline refreshed, and `npm audit` now runs through `scripts/npm-audit-gate.mjs` with a reviewed allowlist for node-forge GHSA-86w9-cpqp-85rv (only reachable via `win-ca`, signature verification unused, no patched release).

### Changed
- bump vitest 5.0.1 → 5.0.2, vite 8.3.0 → 8.3.1 and the aws-sdk group (5 packages).

## [0.96.9] - 2026-10-01

### Fixed
- stop electron-builder publishing from the build job, skip POSIX-only tests on Windows

### Changed
- bump lucide-react from 1.47.0 to 1.48.0 (#29)
- bump jsdom from 30.1.0 to 30.1.1 (#27)

## [0.96.8] - 2026-10-01

### Changed
- **SFTP now runs over the system OpenSSH client (`ssh -s sftp`)** instead of the `ssh2` / `ssh2-sftp-client` JavaScript libraries, with a built-in SFTP v3 protocol engine. The file manager now honours `~/.ssh/config`, ProxyJump (`-J`), FIDO2 security keys and PKCS#11 smartcards exactly like the terminal. `ssh2` and `ssh2-sftp-client` are removed.
- **FIDO2 profiles can use the SFTP file manager** (the buttons are no longer disabled). PIN prompts use the app's PIN dialog and the touch banner is shown. Resident keys remain Linux-only; on Windows use a key file.
- **Host keys for SFTP** are verified by OpenSSH against `~/.ssh/known_hosts`; unknown keys open the trust dialog (rejected if it can't be shown), changed keys are refused.
- Remote tail and search previews run through OpenSSH (`exec`) instead of the old SSH channel.

### Fixed
- Password profiles no longer hang in the terminal/SFTP when the default ssh-agent holds a touch/PIN-protected key (pubkey auth is disabled for password profiles).
- Restored terminal tabs reuse the profile's saved password/passphrase instead of prompting again.
- The SFTP multiplexing socket now lives in a private (0700) temp directory with an unguessable name.

## [0.96.7] - 2026-10-01

### Added
- **Post-transfer integrity & checksum verification (P1 #15)**: automatic SHA-256 / MD5 digest verification on completed file transfers with auto-removal of corrupted destinations and a configurable settings toggle.
- **Headless CI smoke test**: automated Playwright/CDP smoke test in CI verifying rapid app launch, DOM mounting, and UI rendering under 1 second.
- **Directory transfer worker pool**: concurrent worker pool for recursive directory transfers with aggregate real-time progress reporting.
- **Automatic retry on transient transfer failures**: resilient retry logic for socket drops (`ECONNRESET`, `ETIMEDOUT`, `Connection lost`).
- **Security hardening & fuses**: enabled Electron fuses at build time, pinned proxy CLI execution through the signed main executable, and added comprehensive security tests with strict coverage floors.

### Changed
- **Startup time & bundle optimization**: externalized `@kubernetes/client-node` from main process bundle, cutting 4.6 MB and speeding up build time by 88%; non-blocking background initialization of login shell env, trust store, and orphan cleanup.
- **Terminal performance & memory bounds**: added configurable terminal scrollback buffer limit (default 5000 lines) and debounced resize synchronization to prevent IPC message flooding.
- **SFTP stream buffer sizing**: increased read and write stream buffer chunk sizes to 128 KB for 4x fewer roundtrips.

### Fixed
- **Host key verification & argument escaping**: hardened remote file names and argument inputs.
- **AES-GCM crypto**: pinned AES-GCM auth tag length strictly to 16 bytes on decryption.

## [0.96.6] - 2026-09-30

### Added
- **Directory-sync profiles in Remote Profile Sync**: saved directory-sync pairs are now backed up and synced to your S3/SFTP target (new `dirsync-profiles.enc`, per-record merge with tombstones). Deleting a profile is now a soft delete so the deletion propagates; remotes pushed by older versions still pull fine.
- **Home button**: clicking the sshS3 logo in the header shows the landing page again; open tabs stay mounted.

### Fixed
- **Edited S3/SFTP profiles were ignored** until restart: the file manager's cached connection is now dropped when a profile is saved or deleted.
- **"Import Hosts from ~/.ssh/config" dialog** was clipped inside a short Connection Manager.
- **Clean start showed old tabs/profiles**: removed the legacy `multissh` config migration.

### Changed
- README: new screenshot set and a corrected note that FIDO2 profiles have no SFTP on any platform.

## [0.96.5] - 2026-09-30

### Added
- **Windows support fixes**: installer sets the OpenSSH Authentication Agent service to Automatic; Settings gets a "Fix Windows ssh-agent" button (adds a PKCS#11 driver's folder to PATH); global default PKCS#11 driver setting; friendlier driver/certificate names; OpenSC preferred over libykcs11 in detection; new "Windows vs. Linux" README section.

### Fixed
- **FIDO2 on Windows**: resident credentials are disabled in the UI (unavailable there), `ssh-add -K` uses `SSH_SK_PROVIDER=internal`, and a non-empty shared agent no longer hides a failed load.
- **`~/.ssh/config`**: paths containing spaces are quoted in the managed block.
- **SFTP for FIDO2 profiles**: the SFTP button is greyed out with an explanation on all platforms — the file manager's `ssh2` library cannot use security-key (`-sk`) keys, so it could never authenticate.

## [0.96.3] - 2026-09-30

### Added
- **Automated Deploy Script**: added `scripts/deploy.sh` and `npm run deploy` to automatically run pre-flight checks, bump patch versions, stage all changes, commit, create annotated tags, and push to GitHub to trigger GitHub Actions release builds.

### Fixed
- **Smartcard PIN Error Surfacing & Retry**:
  - Added a retry loop (up to 3 attempts) in the smartcard PIN modal with the actual error reason shown inline instead of failing silently after one attempt.
  - Added a non-intrusive status notification banner for background startup-unlock failures.
  - Prevented empty PIN submissions directly in the modal to avoid burning retry attempts.
  - Reclassified smartcard error strings to distinguish between retryable wrong PIN attempts and permanent CTAP2/PIV lockouts.
- **Dependency Security Updates**: resolved all GitHub Dependabot security alerts by updating `brace-expansion` (1.1.21, 2.1.7, 5.0.12) and `fast-uri` (3.1.8).
- **FIDO2 User Presence & PIN Prompts**:
  - Prevented false-positive touch prompt notices during startup PIN entry (`ssh-add -K`).
  - Fixed touch presence banner not displaying when connecting to FIDO2 hosts that require user presence verification while reusing cached PIN.
  - Forwarded askpass presence events through SSHPtyManager and IPC to display the user touch prompt.

## [0.96.2] - 2026-09-29

### Changed
- **New App Branding & Icon**:
  - Replaced application icons across all desktop formats (`.svg`, `.ico`, and `.png` in 16x16 through 512x512) with modern dark squircle and yellow cloud terminal mark (`> _`).
  - Added solid color cloud terminal icon assets (`cloud_icon_yellow`, `cloud_icon_red`, `cloud_icon_blue`, `cloud_icon_orange`).
  - Integrated `BrandLogo` component in header and hero empty state with `sshS3` color-matched styling.
  - Configured Linux desktop file binding (`setDesktopName`) and native image window icon in Electron main process for desktop environments.

## [0.96.1] - 2026-09-28

### Added
- **Named tunnels, managed only from the Tunnels panel**: tunnels now have their own display name, independent of the underlying SSH profile's name; tunnel definitions are created/edited exclusively in the Tunnels panel (removed from the profile editor), and terminal sessions no longer auto-start a profile's saved tunnels — only the Tunnels panel starts them.
- **ProxyJump can reference a saved profile**: the Jump Host / ProxyJump setting can point at another saved SSH profile instead of only free text, resolved to that profile's host/user/port at connect time (falls back to manual text for external bastions). Applies to terminal sessions, SFTP connections (file manager, directory sync, pane auto-reconnect), and the exported `~/.ssh/config` (writes a real `ProxyJump <alias>` instead of a frozen string).
- New README section, "Jump hosts & tunnels explained", documenting ProxyJump and the Tunnels panel end to end.

### Fixed
- **SSH tunnel/terminal port conflicts**, root cause: terminal sessions previously re-started a profile's saved tunnels on every connect, which could collide with the same tunnel already running from the Tunnels panel ("Address already in use"). Terminals no longer auto-start tunnels at all.

## [0.96] - 2026-09-28

### Added
- **SSH Tunnels management UI**:
  - New global "SSH Tunnels" toolbar button (icon colored gray/green/red for none/active/error) opening a cross-connection tunnel dashboard, plus a per-connection tunnels modal reachable from the Connection Manager.
  - Added a guided 3-step wizard (Type → Details → Done) for creating local/remote/dynamic (SOCKS) port-forward tunnels, with plain-language explanations, a live summary sentence, and an in-wizard local-port-in-use check.
  - Standalone tunnels now run as independent `ssh -N` processes with live status (active/error), start/stop, and in-place editing, decoupled from any open terminal session.

### Fixed
- **SSH tunnel & terminal port conflicts**: opening a terminal or another tunnel that would collide with an already-bound local port (from a running standalone tunnel or another open terminal session) now silently skips that forward instead of surfacing a raw "Address already in use" error from OpenSSH.
- **Orphaned processes on shutdown**: standalone tunnel processes and terminal ControlMaster ("mux") connections are now reliably terminated on app quit, including when the process receives an external SIGINT/SIGTERM (e.g. `kill`/`pkill`, a session/system shutdown) — previously this bypassed Electron's quit lifecycle entirely and left `ssh` processes running.
- Fixed a race where saving an edit to a running tunnel could briefly fail with "Address already in use" before the old process had fully released its port.
- Fixed a stale "phantom" tunnel entry lingering in the UI after a tunnel failed to start.

## [0.94] - 2026-09-26

### Added
- **FIDO2 & Hardware Security Keys (YubiKey)**:
  - Added native FIDO2 resident credential discovery and key generation (`ed25519-sk`, `ecdsa-sk`) via `ykman` and `ssh-keygen -K`.
  - Added in-app touch presence notification banner ("Touch your security key to authenticate") when security keys require physical verification.
  - Added support for both resident credentials and file-based security keys (`id_ed25519_sk`, `id_ecdsa_sk`) in SSH connection profiles.
  - Added global agent pre-loading for FIDO2 credentials at application startup with a single PIN verification.
  - Added OpenSSH connection multiplexing (`ControlMaster`/`ControlPath`) for background dotfiles sync, allowing synchronization over existing FIDO2 sessions without requiring multiple physical touches.
  - Added automated private `ssh-agent` cleanup on process exit to avoid orphaned agent processes.
- **In-App File Editor with Live Markdown Preview**:
  - Added Edit/Preview mode toggle for `.md`, `.markdown`, and `.mdx` files in the dual-pane file manager editor.
  - Integrated GitHub Flavored Markdown (GFM) renderer using `react-markdown` and `remark-gfm` with support for tables, task lists, code formatting, and theme styling.
  - Lazy-loaded markdown preview bundle to maintain instant app startup.

### Fixed
- **Smartcard & PKCS#11 Startup Preload & Detection**:
  - Enhanced PKCS#11 library detection with SONAME matching (`.so.2`, `.so.1`) and realpath deduplication, resolving detection of `libykcs11` (YubiKey PIV).
  - Preloaded all detected/configured profile PKCS#11 libraries at startup using a transient PIN verification without storing or caching the PIN in application memory.

---

## [0.93] - 2026-09-25

### Added
- **Quick Start workspace dashboard**:
  - Replaced empty tab state with a welcoming 4-card dashboard (New Terminal, New File Manager, Saved Connections, Cloud Sync & Backup) with keyboard shortcuts and descriptions.
  - Added shortcut badges (`Ctrl+Shift+T`, `Ctrl+Shift+F`) to TabBar New Tab dropdown menu.
  - Added quick split horizontally and vertically buttons to split view top bar.
- **Split pane active indicator & click-to-focus**:
  - Added active focus glow ring, accented header, and live pulsing status dot to the active terminal split pane.
  - Added capture-phase event listeners to activate split panes immediately upon clicking anywhere inside the terminal area or focusing xterm.
- **Dual-pane File Manager enhancements**:
  - Added active pane state tracking (`activeSide`) with distinct focus ring and "Active" badge.
  - Reorganized toolbar buttons into 5 logical separator-delimited groups (Navigation, Breadcrumbs, File Operations, Management, Search & Tools).
  - Added manual edit button and full-path text selection in Breadcrumbs.
  - Added failed transfers count badge in Transfer Queue drawer header.
- **Modal sizing & window consistency**:
  - Expanded `FileEditorModal` and `DirectorySyncModal` default sizes to `94vw` / `88vh`.
  - Added Maximize/Restore toggle buttons and titlebar double-click to toggle fullscreen across all modals.
  - Added global `Esc` key handling to close modals safely.

---

## [0.92] - 2026-09-25

### Added
- **Search in Files UI overhaul**:
  - Significantly expanded default window size (`95vw` / `90vh`, up to 1600px width).
  - Added Maximize/Restore button and titlebar double-click to toggle fullscreen.
  - Added draggable splitter divider to adjust results list and preview pane widths, with double-click to reset.
  - Added full path copy and "Reveal in Explorer" buttons to the preview pane.
  - Added clear button (`✕`) in the search input query box and `Esc` shortcut to close modal.

### Fixed
- **Search in Files warning visibility**:
  - Removed line truncation on search warnings so long paths and permission-denied messages (e.g., `/tmp/systemd-private-*`) are fully readable without being cut off.
  - Added native tooltips for paths and snippets in both results and warning lists.
  - Added one-click "Copy all warnings" and dismiss action to collapse or hide skipped object notices.
- **Terminal session preservation on pane split & unsplit**:
  - Preserved active terminal sessions across pane split and unsplit actions by keying portals and connection identity.
  - Prevented unnecessary session teardowns and restarts when splitting views.
  - Fixed Linux GPU crash fallback handling during pane layout transitions.

---

## [0.91] - 2026-09-25

### Fixed
- **Terminal size synchronization on startup & tab activation**:
  - Centralized terminal PTY sizing and fixed issue where terminal dimensions were stuck at 80×24 rows/cols on application startup and tab restoration.
  - Resolved issue where background tabs activating for the first time failed to calculate terminal dimensions due to unmeasured font metrics during `display: none` mount; added forced character metric measurement and scheduled re-sync passes across animation frames and timers.

### Added
- **OpenShift toggle in Settings**:
  - Added an "Enable OpenShift support" setting toggle (`enableOpenShift`) under Settings → General.
  - Conditionally displays the "OpenShift (oc login)" action in the Kubernetes connection tree and starts the local OpenShift CLI shim only when OpenShift support is enabled.
- **OpenShift OAuth token login & CLI shim**:
  - Built-in OpenShift OAuth login and token extraction support.
  - Cross-platform `oc` emulation shim with live kubeconfig watching.

### Changed & Updated Dependencies
- **Tailwind CSS v4 Migration**: Migrated from Tailwind CSS v3 to Tailwind CSS v4 using `@tailwindcss/vite` and native CSS `@theme`.
- **Smartcard Net iD PKCS#11 stability**: Isolated Net iD PKCS#11 crashes and improved fallback when PIN prompting is required.
- Updated dependencies: `jsdom` (30.1.0), `lucide-react` (1.47.0), `typescript-eslint` (8.70.1), and `@types/node` (22.20.4).

---

## [0.9] - 2026-09-24

### Security & Hardening
- **CodeQL workflow permission hardening**: Enforced explicit `permissions: contents: read` in `.github/workflows/ci.yml` adhering to the principle of least privilege.
- **CSS attribute selector sanitization**: Hardened `focusElement` in `FileList.tsx` by escaping backslashes prior to quotes to prevent selector breakout on special path characters.
- **GitHub automated security analysis**: Enabled GitHub Secret Scanning validity checks, non-provider pattern scanning, and Private Vulnerability Reporting (`/security/advisories`).
- **Dependabot configuration & policy**: Added `.github/dependabot.yml` with automated weekly dependency checks, group bundling (`@aws-sdk/*`, `actions/*`), and protection against breaking major peer dependency updates (TypeScript 7, React 19).

### Changed & Updated Dependencies
- Updated AWS SDK packages (`@aws-sdk/client-s3`, `@aws-sdk/client-sso`, `@aws-sdk/client-sso-oidc`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`) to `3.1137.0`.
- Updated `electron` to `44.4.3`.
- Updated `eslint` to `10.11.0`, `vitest` to `5.0.1`, and `autoprefixer` to `10.6.1`.
- Upgraded CI and Release GitHub Actions workflows to latest major versions (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`, `softprops/action-gh-release@v3`).
- Added interface screenshots for Kubernetes Pod File Explorer and Live Pod Debugging to `README.md`.

---

## [0.8] - 2026-09-24

### Added
- **Kubernetes Live Pod Debugging (`kubectl debug`)**:
  - Live injection of ephemeral debug containers directly into running pods without restarting them via `K8sDebugService` (`/ephemeralcontainers` subresource).
  - Target container process & IPC namespace sharing (`targetContainerName`), enabling inspecting processes (`ps`), sockets (`netstat`), and filesystems across containers in the same pod.
  - Interactive debugging modal with pre-configured toolsets: **Netshoot** (network troubleshooting), **RHEL Support Tools** (sysstat, strace, gdb, ubi9), **BusyBox** (minimal shell), **Curl** (HTTP/API testing), and **Ubuntu**.
  - Configurable debug image presets in Settings under a new dedicated **Kubernetes & Debug** tab, supporting custom corporate images, registry paths, and default shell commands.
  - Automatically launches an interactive terminal session in the debug container upon attachment.
  - Pod listing and detail views now display ephemeral containers with a distinct `[debug]` / `[Ephemeral Debug]` badge.
- **Kubernetes Pod File Explorer**:
  - Full dual-pane file management inside running Kubernetes/OpenShift containers via `K8sPodStorageProvider` using non-interactive Exec streams.
  - Browse directories, download, upload, create folders, rename, delete, and chmod files directly in container filesystems.
  - In-place file viewing and editing via internal `FileEditorModal` and external editors (`FileEditorService`), streaming changes back on save.
  - "Browse Files" button in `K8sConnectionTree` and `K8sPodDetailModal` to jump directly into a container's filesystem.
  - "Open Terminal Here" inside pod folders to launch an interactive container shell rooted in the current path.

---

## [0.7] - 2026-09-24

### Security & Hardening
- **X11 server isolation & argument sanitization**:
  - Restricted internal X server spawning strictly to Windows platforms.
  - Added binary allowlist (`vcxsrv.exe`, `xming.exe`, `xwin.exe`) preventing execution of arbitrary user-specified binaries.
  - Stripped unsafe `-ac` access control bypass flag from user-supplied server arguments.
- **Smartcard SSH argument injection prevention**:
  - Filtered dangerous OpenSSH directives (`ProxyCommand`, `LocalCommand`, `PermitLocalCommand`, `RemoteCommand`, `Match`, `Include`) from agent argument construction.
  - Stripped newline and carriage return characters from extra option keys and values.
- **Dotfile pool path traversal defense**:
  - Validated pool IDs against path traversal sequences (`..`, path separators) preventing recursive deletion or arbitrary directory wipe.
  - Enforced strict containment within pool master directory for local files.
- **Session credential sanitization**:
  - Recursively scrubbed plaintext passwords and passphrases from session tab trees prior to disk persistence in `session.json` and upon session loading.
- **Electron window navigation hardening**:
  - Added `will-navigate` and `will-redirect` guards to prevent renderer top-level navigation to unauthorized URLs or dropped files.
- **URL scheme validation for AWS SSO**:
  - Enforced `http:`/`https:` scheme validation before launching external browsers for verification URIs.
- **Known hosts line injection defense**:
  - Validated hostnames, ports, and key types to reject line injection and control characters before appending to `~/.ssh/known_hosts`.
- **Command line null-byte stripping**:
  - Stripped null bytes (`\0`) in `quoteShellArg` to prevent POSIX shell command truncation.
- **Cross-platform Kubeconfig resolution**:
  - Used `os.homedir()` instead of `process.env.HOME` for reliable kubeconfig lookup on Windows.

---

## [0.6] - 2026-09-24

### Fixed
- **Kubernetes HTTP/2 stream timeout & process crash**:
  - Intercepted the piped source stream in `K8sLogManager` to handle `undici` HTTP/2 timeouts (`TypeError: terminated`) and remote connection drops gracefully without triggering an unhandled exception dialog.
  - Added stream error listeners in `K8sPortForwardManager` and `K8sTerminalManager`.
  - Added a global `uncaughtException` protection in the Electron main process to safely ignore benign stream timeouts and transient socket disconnects.

---

## [0.5] - 2026-09-24

### Added
- **File manager desktop & Windows ergonomics**:
  - Auto-scroll when dragging items near top or bottom edges of the file list via `requestAnimationFrame`.
  - Neutral drop zone at the bottom of the file list and interactive breadcrumb segments as drop targets, allowing files to be safely dropped into current folder root or ancestor paths.
  - Spring-loaded folders (hover-to-open after 900ms) on folder rows and breadcrumb segments during drag operations.
  - File clipboard operations (`Ctrl+C` copy, `Ctrl+X` cut with visual dimming, `Ctrl+V` paste) available through keyboard shortcuts and context menus.
  - Directory navigation history per pane with toolbar Back/Forward buttons, `Alt+Left`/`Alt+Right` shortcuts, and mouse back/forward button support.
  - Windows keyboard navigation shortcuts: `F2` to rename, `F5` to refresh directory, `Alt+Up` to navigate to parent directory, and `Escape` to cancel active drag operations.
- **Kubernetes pod describe & events viewer**:
  - Detailed pod inspector modal (`K8sPodDetailModal`) showing status, conditions, IP addresses, node placement, containers, and live event stream.
- **Kubernetes port forwarding**:
  - Forward local ports to cluster pods with auto-assignment of non-privileged ports, traffic buffering, and one-click browser launch (`K8sPortForwardModal` & `K8sPortForwardManager`).

### Fixed
- **Smartcard PKCS#11 concurrent access**:
  - Read certificate details prior to `ssh-add -s` invocation to eliminate token session contention and prevent driver crashes (e.g. Net iD SIGTRAP).
- **Kubernetes port forward session initialization**:
  - Fixed variable assignment in port forward manager session creation.

---

## [0.4] - 2026-09-23

### Added
- **OpenShift Projects & RBAC fallback**:
  - Automatic fallback to OpenShift Projects API (`project.openshift.io/v1`) when `client.listNamespace()` fails with `403 Forbidden` for non-cluster-admin users.
  - Secondary fallback to `context.namespace` from `~/.kube/config` for heavily restricted developer accounts.
  - Support for OpenShift project display names (`openshift.io/display-name`) in the tree view.
  - OpenShift cluster detection badge in the cluster list.
  - Real-time search filter in the Kubernetes dialog to quickly filter across clusters, projects, and pods.

### Fixed
- **Terminal title detection** — Added `oc`, `helm`, `minikube`, `k9s`, and `crc` to disallowed title prefixes to prevent active CLI commands from being mistakenly recognized as remote hostnames.
- **File descriptor leak on Linux local terminals** — Wrapped local shell execution in `/bin/sh` to close leaked Electron file descriptors (such as GPU and Dawn caches) before executing the user's shell, preventing SELinux AVC denials when running tools like `kubectl`/`k3s` and `iptables-restore`.

---

## [0.3] - 2026-09-23

### Added
- **Kubernetes / OpenShift cluster exploration & exec terminal** — Added a new "Kubernetes" tab in the Connection Manager and "+" tab menu:
  - `K8sDiscoveryService` parses `~/.kube/config` and lazily inspects cluster contexts, namespaces, pods, and containers without blocking on unreachable clusters.
  - `K8sTerminalManager` runs interactive exec sessions into containers over WebSockets, functioning seamlessly inside the tab/pane layout.
  - `K8sLogManager` & `K8sLogView` stream live container logs into resizable panes with search support via `@xterm/addon-search` and safe abort handling.
  - Lazy-loads `@kubernetes/client-node` on first use to preserve app startup speed.

### Fixed
- **Smartcard certificate cache** — Cached certificate details at agent load instead of querying the PKCS#11 token on every dropdown open, eliminating session contention and process crashes with drivers like Net iD.

---

## [0.2.24] - 2026-09-22

### Added
- **Certificate details in "Cached smartcard identities"** — each cached identity in the top-bar smartcard popover (`TabBar.tsx`) can now be expanded to show its certificate's Subject, UPN (Microsoft `otherName` SAN, common on PIV/CAC/SITHS cards), and validity period. Reads the certificate directly from the same PKCS#11 module (`.so`/`.dll`) already used for `ssh-add -s`, via a new `pkcs11js` native binding ([SmartcardCertificateReader.ts](src/main/smartcard/SmartcardCertificateReader.ts)) — not a vendor CLI tool like OpenSC's `pkcs11-tool`, which isn't installed at all for providers such as Net iD. Matches each certificate to its `ssh-add`-reported identity by independently computing the SSH fingerprint of the certificate's public key ([CertificateParser.ts](src/main/smartcard/CertificateParser.ts)), including a small hand-written DER walker for the UPN extension, which Node's built-in `X509Certificate` doesn't decode.

---

## [0.2.23] - 2026-09-22

### Fixed
- Fixed two tests that deterministically failed the Windows leg of the release build (blocking every release since 0.2.21): both asserted Unix-only `ssh-agent` spawn/injection behavior without accounting for `process.platform === 'win32'`, where that's intentionally skipped ([AgentLifecycleManager.test.ts](tests/main/AgentLifecycleManager.test.ts), [SSHPtyManager.test.ts](tests/main/SSHPtyManager.test.ts)).

---

## [0.2.22] - 2026-09-22

### Added
- New **directory sync** between any two hosts (local/SFTP/S3, including remote↔remote): right-click a folder in the dual-pane file manager and choose "Sync to..." to compute a size+mtime diff against a target (defaulting to the other pane), review a New/Changed/Only-in-target report — including a per-file content **Compare** view — choose what to apply, and optionally delete files missing from the source. Sync pairs can be saved and re-run as named profiles from a "Saved Sync Profiles" list, always re-diffing before applying ([DirectorySyncService.ts](src/main/dirsync/DirectorySyncService.ts), [DirectorySyncModal.tsx](src/renderer/src/components/FileManager/DirectorySyncModal.tsx), [FileDiffModal.tsx](src/renderer/src/components/FileManager/FileDiffModal.tsx)).
- `IStorageProvider` gained an optional `setModifiedTime()`, implemented for local disk and SFTP, so a directory sync copy preserves the source's original modification time on the target instead of taking the write time — otherwise every synced file would look "changed" again on the very next re-sync ([storage.ts](src/shared/types/storage.ts), [LocalStorageProvider.ts](src/main/storage/LocalStorageProvider.ts), [SFTPStorageProvider.ts](src/main/storage/SFTPStorageProvider.ts)).

---

## [0.2.21] - 2026-09-21

### Added
- New opt-in **"Unlock smartcard at app startup"** toggle (Settings → Security & Smartcard, only shown under 'agent-global' PIN caching): prompts for the PIN as soon as the app opens instead of waiting for the first connection that needs it, so the card is already unlocked by the time you open your first terminal — including a local shell tab, which otherwise triggers no smartcard prompt on its own. Prefers `p11-kit` when it's among the detected PKCS#11 libraries (it proxies every other registered module, so e.g. `p11-kit-proxy.so` and `opensc-pkcs11.so` coexisting is one physical card reachable two ways, not two cards to pick between); otherwise only acts when exactly one non-p11-kit library is detected ([IpcBridge.ts](src/main/IpcBridge.ts)).

### Fixed
- Fixed local shell terminal tabs not reliably getting the app's own managed `ssh-agent`: `SSH_AUTH_SOCK` is now set explicitly rather than relying on inherited `process.env`, and — when a smartcard is cached under 'agent-global' PIN caching — points at that same cached agent instead of a generic default one, so an already-unlocked card is immediately usable from a plain shell too ([SSHPtyManager.ts](src/main/ssh/SSHPtyManager.ts), [IpcBridge.ts](src/main/IpcBridge.ts)).
- Fixed a race condition in `AgentLifecycleManager.ensureAgent()` where a caller arriving while a spawn was already in flight got a stale/premature status snapshot instead of the actual final result, which could leave a local shell tab opened right at startup (e.g. one restored from session) with no `SSH_AUTH_SOCK` override at all ([AgentLifecycleManager.ts](src/main/ssh/AgentLifecycleManager.ts)).

---

## [0.2.20] - 2026-09-20

### Added
- Remote Profile Sync now generates the managed `~/.ssh/config` block directly from your saved SSH profiles (host/port/user/identity file/proxy jump/etc.) on every push, instead of only mirroring a hand-written block — so a plain `ssh <alias>` in any terminal picks up the same settings as the matching profile ([SshNativeFileMerger.ts](src/main/services/SshNativeFileMerger.ts), [ProfileSyncService.ts](src/main/services/ProfileSyncService.ts)).
- Terminal tabs and split panes now dynamically retitle themselves to track the current remote host as you `ssh` onward from one machine to another, instead of staying fixed to the original connection ([terminalTitle.ts](src/renderer/src/lib/terminalTitle.ts), [App.tsx](src/renderer/src/App.tsx), [TerminalView.tsx](src/renderer/src/components/TerminalView.tsx)).
- Settings → Terminal and the connection profile form now detect native Linux X11/Wayland and show a Linux-specific status instead of the Windows-only VcXsrv server controls ([XServerManager.ts](src/main/x11/XServerManager.ts), [SettingsModal.tsx](src/renderer/src/components/SettingsModal/SettingsModal.tsx)).

### Fixed
- Fixed private smartcard `ssh-agent` processes/sockets under `~/.ssh/agent` leaking past app quit: `dispose()` detached the PTY-exit listener that normally reaps them before calling `killAll()`, so per-session agents were never killed on exit ([IpcBridge.ts](src/main/IpcBridge.ts)).
- Fixed `PROFILE_SYNC_LINK_SMARTCARD`/`PROFILE_SYNC_UNLOCK_SMARTCARD` always spawning a fresh private agent (and re-prompting for the PIN) even when 'agent-global' PIN caching mode already had one cached for that card ([IpcBridge.ts](src/main/IpcBridge.ts)).
- Fixed local shell terminal tabs not reliably inheriting the app's own managed `ssh-agent`: `SSH_AUTH_SOCK` is now set explicitly from `AgentLifecycleManager` instead of relying on `process.env` inheritance alone ([SSHPtyManager.ts](src/main/ssh/SSHPtyManager.ts)).

### Docs
- Corrected several stale README claims found by auditing recent commits: bundled VcXsrv args no longer document the removed `-ac` (access-control-disabling) flag, ECDSA smartcard sync-unlock limitations are now described accurately, and the `~/.ssh/config` sync bullet reflects profile-based generation.

---

## [0.2.19] - 2026-09-20 15:27

### Fixed
- Fixed the light/dark theme toggle leaving both `dark` and `light` classes on `<html>` simultaneously, so Tailwind `dark:` variant colors (e.g. the destructive-action red in the file manager's right-click menu) kept incorrectly applying while in light mode ([App.tsx](src/renderer/src/App.tsx)).
- Fixed the Security & Smartcard settings panel unconditionally claiming "OS Keychain Encryption Active" regardless of actual status; it now reflects the real `getSecurityStatus()` result, matching the plaintext-credentials warning banner added in 0.2.18 ([SettingsModal.tsx](src/renderer/src/components/SettingsModal/SettingsModal.tsx)).

---

## [0.2.18] - 2026-09-20 11:32

### Security
- Fixed a shell command injection in the SSH `ProxyCommand` built for HTTP/SOCKS proxy connections: proxy host/destination host are now validated against a safe hostname charset, and proxy username/password are passed via environment variables instead of being interpolated into the shell string ([`SmartcardDetector.ts`](src/main/smartcard/SmartcardDetector.ts), [`proxyCli.cjs`](src/main/proxy/proxyCli.cjs), [`SSHPtyManager.ts`](src/main/ssh/SSHPtyManager.ts)).
- Fixed the bundled X11 server (VcXsrv) being reachable with no authentication: removed `-ac` (which disabled X11 access control) and narrowed the Windows Firewall rule from all networks to Private/Domain only ([`XServerManager.ts`](src/main/x11/XServerManager.ts), [`installer.nsh`](build/installer.nsh)).
- Fixed arbitrary ssh_config directive injection (`ProxyCommand`, `LocalCommand`, `PermitLocalCommand`, `RemoteCommand`, `Match`, `Include`) via Remote Profile Sync's `~/.ssh/config` mirroring: these directives are now stripped before any synced block is written to the user's real ssh config ([`SshNativeFileMerger.ts`](src/main/services/SshNativeFileMerger.ts)).
- Fixed a path traversal in dotfiles pool sync that allowed a `remotePath` with `../` segments to write outside the connected server's home directory ([`DotfileSyncService.ts`](src/main/dotfiles/DotfileSyncService.ts)).
- Fixed smartcard-only Remote Profile Sync unlock (no saved master password) deriving a different, non-reproducible key on every unlock for ECDSA-backed cards; now refuses that mode for ECDSA keys with a clear error, and uses a fixed derivation message (instead of the random liveness challenge) for the Ed25519/RSA cards where it can work reliably ([`SmartcardSyncService.ts`](src/main/smartcard/SmartcardSyncService.ts), [`IpcBridge.ts`](src/main/IpcBridge.ts)).
- Added a UI warning when saved SSH/S3 credentials can't be encrypted via the OS keyring and are falling back to plaintext on disk ([`CredentialEncryptionWarningBanner.tsx`](src/renderer/src/components/CredentialEncryptionWarningBanner.tsx)).
- Hardened the external file editor's temporary directory/file permissions to owner-only (`0700`/`0600`) on multi-user systems ([`FileEditorService.ts`](src/main/editor/FileEditorService.ts)).

---

## [0.2.9] - 2026-09-17 19:41

### Security
- Upgraded `electron` from `31.7.7` to `44.4.1`, resolving 23 Chromium/V8 vulnerabilities and replacing vulnerable `extract-zip` and `cacheable-request` subdependencies with secure modern packages (0 audit vulnerabilities).

---

## [0.2.8] - 2026-09-17 19:33

### Added
- Virtual scrolling in [`FileList.tsx`](src/renderer/src/components/FileManager/FileList.tsx) using `@tanstack/react-virtual` for fast rendering of directories with 10,000+ files.
- Dynamic code-splitting in Vite / Rolldown build separating `xterm`, `react-vendor`, and `lucide-react` bundles.
- Terminal scrollback replay buffer (128 KB) and auto-reconnect logic in [`SSHPtyManager.ts`](src/main/ssh/SSHPtyManager.ts) when SSH connections drop unexpectedly.
- End-to-end cross-provider transfer integration test suite [`TransferCrossProviderE2E.test.ts`](tests/main/TransferCrossProviderE2E.test.ts).
- Local shell terminals for Windows (PowerShell/CMD) and Linux/macOS (bash/zsh) via [`LocalPtyManager.ts`](src/main/ssh/LocalPtyManager.ts).
- SSH agent auto-spawning and Windows Pageant/OpenSSH service detection in [`AgentLifecycleManager.ts`](src/main/ssh/AgentLifecycleManager.ts).
- Opt-in dotfiles pool synchronization on SSH connections ([`DotfilePoolStore.ts`](src/main/dotfiles/DotfilePoolStore.ts) & [`DotfileSyncService.ts`](src/main/dotfiles/DotfileSyncService.ts)).
- Open source project documentation: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`SECURITY.md`](SECURITY.md), and GitHub issue/PR templates.
- Explicit MIT License in [`LICENSE`](LICENSE) and [`package.json`](package.json).

### Fixed
- Fixed ESM `ReferenceError: __dirname is not defined` and missing `proxyCli.cjs` packaging in electron-builder.
- Fixed directory duplicate subfolder nesting bug in [`TransferPipeline.ts`](src/main/transfer/TransferPipeline.ts) and [`TransferQueue.ts`](src/main/transfer/TransferQueue.ts).
- Resolved Vite Fast Refresh component export warnings in `DragDropLayer.tsx` and `FilePane.tsx`.
- Resolved tab recycling, system trust store, and S3/SFTP transfer boundary bugs.

---

## [0.2.7] - 2026-09-17 18:00

### Added
- Opt-in dotfiles pool synchronization on SSH connections (`DotfilePoolStore.ts` & `DotfileSyncService.ts`).
- Dual-pane file manager with drag-and-drop transfers across Local, SFTP, and S3 providers.
- Smartcard PKCS#11 authentication detector and native Askpass server.
- TOFU (Trust On First Use) host key verification and encrypted known hosts storage.
- Comprehensive `ARCHITECTURE.md` developer guide.
