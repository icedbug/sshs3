# sshs3

[![CI](https://github.com/alun-hub/sshs3/actions/workflows/ci.yml/badge.svg)](https://github.com/alun-hub/sshs3/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/alun-hub/sshs3?style=flat&color=3388ff)](https://github.com/alun-hub/sshs3/releases/latest)
![Platform: Linux | Windows](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-blue)
[![Downloads](https://img.shields.io/github/downloads/alun-hub/sshs3/total?color=success)](https://github.com/alun-hub/sshs3/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **A modern, security-focused, cross-platform SSH, SFTP, S3, and Kubernetes client** for Linux and Windows, featuring hardware security key & smartcard support (FIDO2 / YubiKey / PKCS#11 / SITHS / Net iD), split terminal views, a dual-pane file manager with live Markdown preview, directory sync, and container exec & log tools.

> [!WARNING]
> **Early Development Notice**: sshs3 is under active early-stage development. Expect occasional bugs, incomplete edge-case handling, and breaking changes or frequent UI improvements between releases. Feedback and bug reports are warmly welcome — please file any issues or suggestions on [GitHub Issues](https://github.com/alun-hub/sshs3/issues)!

---

## Screenshots & Interface Tour

<details open>
  <summary><b>🖥️ Terminal & Split Views</b> (SSH, Local Shell)</summary>
  <br>
  <p align="center">
    <img src="docs/screenshots/landing.png" alt="sshS3 start screen" width="850" />
    <br><em>Start screen with quick access to terminals, the file manager, saved connections and cloud sync</em>
  </p>
  <p align="center">
    <img src="docs/screenshots/split.png" alt="Three split panes: remote SSH, local shell and a second SSH session" width="850" />
    <br><em>Konsole-style recursive split panes (horizontal & vertical) with independent sessions</em>
  </p>
</details>

<details>
  <summary><b>☸️ Kubernetes & OpenShift</b> (Cluster Tree, Pods, Exec, Logs, File Explorer & Live Debugging)</summary>
  <br>
  <p align="center">
    <img src="docs/screenshots/conn-k8s.png" alt="Connection Manager Kubernetes tab" width="850" />
    <br><em>Lazy-loading Kubernetes & OpenShift cluster tree from ~/.kube/config</em>
  </p>
  <p align="center">
    <img src="docs/screenshots/k8s-debug.png" alt="Attach Debug Container dialog with Netshoot preset" width="850" />
    <br><em>Live ephemeral pod debugging (kubectl debug) with preset tools and process namespace sharing</em>
  </p>
</details>

<details>
  <summary><b>📁 Dual-Pane File Manager & S3 Object Storage</b> (SFTP, S3, Directory Sync)</summary>
  <br>
  <p align="center">
    <img src="docs/screenshots/filemanager.png" alt="Connection Manager S3 tab over the dual-pane file manager" width="850" />
    <br><em>Dual-pane file explorer for local disk, SFTP servers, and S3 buckets, with the Connection Manager</em>
  </p>
  <p align="center">
    <img src="docs/screenshots/file-options.png" alt="Dual-pane file manager with an S3 bucket and local disk, showing the context menu" width="850" />
    <br><em>File operations from the context menu: copy, rename, permissions, properties and more</em>
  </p>
  <p align="center">
    <img src="docs/screenshots/markdown.png" alt="Built-in editor showing a rendered Markdown preview" width="850" />
    <br><em>In-app editor with live Markdown preview</em>
  </p>
  <p align="center">
    <img src="docs/screenshots/s3-options.png" alt="S3 bucket next to a Kubernetes pod filesystem, with bucket policy, CORS and versioning in the context menu" width="850" />
    <br><em>Bucket management: policies, CORS configuration, tagging, and object versioning</em>
  </p>
</details>

<details>
  <summary><b>🔀 SSH Tunnels</b> (Local, Remote, SOCKS)</summary>
  <br>
  <p align="center">
    <img src="docs/screenshots/ssh-tunnels.png" alt="SSH Tunnels dialog listing saved forwards per connection" width="850" />
    <br><em>Saved port forwards (-L / -R / -D) per connection</em>
  </p>
</details>

---

## Overview

**sshs3** is an Electron desktop app that pairs a full xterm.js terminal with a dual-pane file explorer for SFTP, S3-compatible object storage (AWS, MinIO, NetApp), and Kubernetes container filesystems, plus integrated Kubernetes / OpenShift cluster discovery, container exec terminals, live ephemeral pod debugging (`kubectl debug`), and log streaming. It's built for sysadmins, DevOps, and developers who work across many servers and clusters, connect through jump hosts/bastions, and need hardware security token authentication (FIDO2 resident credentials, YubiKey, and PKCS#11 smartcards).

Under the hood it's a fairly thin, security-conscious shell around a handful of proven building blocks: your system's own `ssh` binary drives the terminal (so `~/.ssh/config`, agents, and aliases just work), the same `ssh` binary also carries SFTP file transfers (`ssh -s sftp`, with a small built-in SFTP v3 protocol engine on top), and the AWS SDK talks to any S3-compatible endpoint. See [How it works](#how-it-works) below for the architecture, [Built on open source](#built-on-open-source) for the full list of libraries this project depends on, and the [Product Comparison Guide](docs/COMPARISON.md) for a detailed comparison against PuTTY, MobaXterm, WinSCP, and S3 Browser.

### Quick Download

| Platform | Format | Download |
| :--- | :--- | :--- |
| **Linux** | Standalone AppImage | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`.AppImage`) |
| **Linux (Debian / Ubuntu)** | DEB package | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`.deb`) |
| **Linux (Fedora / RHEL)** | RPM package | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`.rpm`) |
| **Windows** | Setup Installer (with bundled VcXsrv) | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`sshs3-Setup-*.exe`) |
| **Windows** | Portable standalone | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`sshs3-*-portable.exe`) |
| **Windows** | Portable ZIP (unpack & run) | [GitHub Releases](https://github.com/alun-hub/sshs3/releases/latest) (`sshs3-*.zip`) |

**Updates:** the app checks GitHub Releases for a new version shortly after start and every 6 hours (switch off under *Settings → App Behavior*). Nothing is downloaded or installed until you click *Download* and then *Restart and install*. This works for the AppImage and the DEB/RPM packages (DEB/RPM ask for administrator rights). Windows builds are not code-signed yet, so on Windows the app does not update itself: download new versions from the releases page. The only network request is to GitHub Releases. On air-gapped machines, untick the setting, or set the environment variable `SSHS3_DISABLE_UPDATES=1` to switch the feature off completely (the setting is then locked and no update traffic is made). Release assets carry `SHA256SUMS` and a build-provenance attestation if you prefer to verify manually.

---

## Features

### Terminal, tabs & split view
- **Real OpenSSH process via `node-pty`** — the terminal spawns your system's actual `ssh` binary, not a JS reimplementation, so `~/.ssh/config`, `ssh-agent`, host aliases, and every OpenSSH option behave exactly as they do on the command line.
- **Dynamic tab & pane titles** — tab titles automatically track remote host names and commands, keeping multiple open sessions easy to distinguish at a glance.
- **Local shell terminals** — open a plain local shell tab (your `$SHELL` on Linux/macOS, or a chosen `cmd`/PowerShell/`pwsh` and installed WSL distributions on Windows) alongside your SSH sessions. On Linux/macOS its `SSH_AUTH_SOCK` is set explicitly rather than just inherited, controlled by **Settings → Local Terminal SSH Agent** (Auto / System Only / Disabled) — see **SSH agent lifecycle management** below for what it actually points at.
- **Recursive split panes (Konsole-style)** — split any pane right or down from its own mini toolbar, any number of times, nesting freely; each pane keeps its own connection picker and isolated session. Splitting never recreates an existing pane's session (it reparents the pane into a new split, exactly like Konsole's `ViewSplitter`), and closing one specific pane leaves every other pane's session untouched — the tree collapses a split down to its remaining child automatically, so no empty slots are left behind. A one-click "Unsplit" action keeps the active pane and closes the rest. Easily cycle through split panes with `Ctrl+Shift+N` (next) and `Ctrl+Shift+P` (previous).
- **Session persistence** — tabs, pane layouts, and per-pane working directories are saved and restored automatically between restarts.
- **Clickable links and file paths** — hold `Ctrl` (`Cmd` on macOS) and click an `http(s)://` URL in a terminal or Kubernetes log to open it in your browser. In SSH terminals, absolute and `~/` file paths (also `path:line:col`) work too: they open that folder in a new SFTP file manager tab. The terminal can't tell files from folders, so a path without a trailing `/` opens its parent folder; `~/` assumes `/home/<user>` (`/root` for root).
- **Search in the terminal (`Ctrl+Shift+S`)** — a search bar over the scrollback with match counter, `Enter` / `Shift+Enter` to step through matches, and match colours that follow the theme (red on Breeze). Selected text is used as the search term. Stepping through matches never triggers copy-on-select.
- **Snippets (`Ctrl+Shift+L`)** — a searchable palette of saved commands, global or limited to one connection, with `{{host}}`, `{{user}}` and `{{date}}` variables. `Enter` types the command, `Ctrl+Enter` types and runs it. Snippets are stored unencrypted in `snippets.json`, so keep passwords and tokens out of them.
- **Copy last command output (`Ctrl+Shift+G`)** — copies what the previous command printed. Exact in shells that send OSC 133 prompt marks (fish, and zsh/bash with shell integration); otherwise it is inferred from your Enter presses, which with a multi-line prompt can include the first prompt line.
- **Clipboard history (`Ctrl+Shift+R`)** — with *copy on select* enabled, every terminal selection is kept in an encrypted, searchable history (OS keyring; memory-only when none is available). `Shift+Insert` and middle-click paste the latest entry; right-click opens the history. Scope (all hosts or per connection) and "empty on exit" are set under Settings.
- **SSH agent lifecycle management** — detects whether `ssh-agent` is already running and, if not, can spawn and manage one itself (Linux/macOS), or detect the Windows OpenSSH Authentication Agent service. A local shell tab's `SSH_AUTH_SOCK` is set explicitly from this and controlled by **Settings → Local Terminal SSH Agent**: **Auto** (default) uses, in priority order, (1) under **Global (App Lifetime)** PIN caching (see below) the app-wide agent, which holds every unlocked smartcard and FIDO2 key — so a card you already unlocked in an SSH terminal is immediately usable for a plain `ssh`/`ssh-add` typed into a local shell tab too, no second PIN prompt, and it works even in a tab opened before the card was unlocked (the agent exists from the first local shell and keeps its socket when you lock and unlock); (2) the app's own agent if it is already running; (3) the system / login-shell agent inherited from your environment (a GUI launch backfills `SSH_AUTH_SOCK`/`SSH_AGENT_PID` from your login shell); (4) otherwise a newly spawned managed agent. **System Only** uses just the inherited system/login-shell socket (if it exists) and never spawns an agent or uses the smartcard agent; **Disabled** sets no `SSH_AUTH_SOCK` at all. (A saved legacy `app-managed` value behaves like Auto.) Since this is resolved once, at the moment that specific tab's shell process is spawned, a local shell tab opened *before* a card is unlocked won't retroactively pick it up — open the tab (or a new one) after unlocking the card.

### AI assistant *(opt-in)*
Help with commands and output without leaving the terminal. It is **off by default**: enable it and pick a provider under **Settings → AI Assistant**, then press `Ctrl+Shift+A` in a terminal.

- **Suggest a command** — describe what you want ("find files over 100 MB under /var, largest first") and get one command back with a short explanation. **Insert into terminal** types it at the prompt; it is never run until you press Enter yourself, and commands that change or delete data are flagged with a warning.
- **Explain output** — select an error or any terminal text (or use the last command's output) and ask what it means and how to fix it.
- **Explain this error** — when a command fails, a small *✨ Explain this error* button appears in the corner of the terminal; one click sends that command's output and shows what went wrong and how to fix it. Failures are read from the exit code in shells that send OSC 133 prompt marks, and otherwise recognised from typical error messages (`command not found`, `No such file or directory`, `Permission denied`, a Python traceback, …). The button only appears while the assistant is turned on.
- **Type what you want, get the command (`Ctrl+Shift+Space`)** — write a plain description at the prompt ("largest folders here, sorted") and press `Ctrl+Shift+Space`: the text is replaced in place by a command, ready to review and run with Enter. With nothing typed, or after line editing the app can't follow (history, tab completion, arrow keys), it opens the assistant instead.
- **Providers** — Anthropic (Claude) with your own API key, or any **OpenAI-compatible** endpoint such as a local [Ollama](https://ollama.com) or LM Studio, so terminal text never has to leave your machine.
- **Built-in Hermes agent *(opt-in)*** — the installers include [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT). Turn on *Use the built-in Hermes agent* and requests go through Hermes, running on your computer, which calls the provider and model you chose and keeps a memory of what you have asked and learned across sessions. Hermes runs with sshs3's guardrails: only its memory, past-session search and to-do tools are on (no shell, file, code, browser or web tools, and every shell command is on its deny list), it listens on `127.0.0.1` only with a fresh key per start, and it starts with a minimal environment, so it gets none of sshs3's passwords, keys, SSH agent or cloud credentials. Its data lives in a `hermes` folder in sshs3's own data folder.
- **Privacy** — nothing is sent until you ask (*Ask*, *Explain this error* or `Ctrl+Shift+Space`); the dialog shows exactly which terminal text is included, and passwords, tokens, AWS keys, bearer headers and private key blocks are masked before anything leaves the app (the same masking the log file uses). The API key is encrypted with the OS keyring and AI settings live in their own `ai-config.json`, which is never part of remote profile sync. Requests go through Chromium's network stack, so the system proxy and certificate store apply.

### Performance bar *(opt-in)*
A slim live-metrics strip above SSH, local-shell and Kubernetes terminals. It is **off by default** — enable it under **Settings → Performance**. While it is off nothing is polled and no extra commands are run.

- **SSH sessions** — sampled over the *already open* OpenSSH connection (the same ControlMaster socket the terminal uses), so there is no extra login, no extra PIN/touch prompt and nothing to install on the server. Each sample runs one fixed, read-only script that reads `/proc` (Linux hosts); `BatchMode=yes` guarantees it can never open a new connection or ask for a password. Available metrics: CPU, RAM, load (vs. core count), swap, disk `/` and every real filesystem, network ↓/↑, disk I/O read/write, iowait, steal, processes, per-core CPU, page cache, uptime and round-trip latency ("Ping").
- **Local shell** — measures your own computer: the same set on Linux, and CPU (total and per core), RAM, uptime and disk (plus load on macOS) on macOS/Windows.
- **Kubernetes pods** — the equivalent of `kubectl top pod`, read from the `metrics.k8s.io` API with the app's own Kubernetes client (no `kubectl` needed): CPU and memory per container, usage against the container's **request and limit**, restarts, Ready, pod age and node. Shows "metrics-server not available" on clusters without metrics-server; refreshes at most every 10 s because metrics-server only updates every ~15–60 s.
- **Three layouts** — compact text, bars (colour-coded green/amber/red gauges) or sparklines — plus a choice of which metrics to show and the update interval (2/5/10/30 s).
- **Hover** the bar for a tooltip with *every* value for that session, including metrics you did not pick for the bar.
- **Click** the bar to open the history view: line charts for up to the last 15 minutes plus "right now" cards — donuts for CPU time (user+sys / iowait / steal / idle), memory (used / cache / free) and swap, load bars against core count, per-filesystem disk bars, per-core CPU, ↓/↑ and read/write bars, request/limit bars for pods, and stat tiles (uptime, ping, processes, node, ready, age). History is kept while the tab is open and survives switching tabs.

### Kubernetes & OpenShift (Clusters, Pods & Containers)
- **Automatic cluster discovery** — Reads `~/.kube/config` and lazily inspects cluster contexts, namespaces, pods, and individual containers inside the Connection Manager and the "+" new-tab menu.
- **Resilient lazy loading** — Never blocks the UI or stalls on unreachable clusters; contexts and namespaces are only queried on-demand when expanded.
- **Interactive container exec terminal** — Open WebSocket-backed interactive tty exec sessions (`sh`, `bash`, or custom commands) directly into running containers, rendered inside the standard split-pane terminal interface (`Ctrl+Shift+D`/`E`).
- **Live container log viewer & search** — Follow container logs in real time in a dedicated resizable pane with search support via `@xterm/addon-search`, auto-scrolling, and crash-resilient abort handling.
- **Kubernetes Pod File Explorer** — Browse, upload, download, view, and edit files directly inside running containers using the full dual-pane file manager interface. Implemented via non-interactive exec streams (`K8sPodStorageProvider`) with zero dependencies or agents required inside the container (works on standard POSIX base images). Supports in-place file viewing/editing with external editors (`FileEditorService`), file permissions (`chmod`), directory creation, and launching a terminal directly in the current container folder ("Open Terminal Here").
- **Live Ephemeral Pod Debugging (`kubectl debug`)** — Attach ephemeral debug containers directly to running pods without restarting them via the Kubernetes `/ephemeralcontainers` API. Inspect distroless or crashed containers with process/PID namespace sharing (`targetContainerName`). Includes pre-configured images for **Netshoot** (network diagnostics), **RHEL Support Tools** (strace, gdb, sysstat, ubi9), **BusyBox**, **Curl**, and **Ubuntu**, plus custom images and commands. Custom presets can be managed under **Settings → Kubernetes & Debug**. Automatically launches an interactive terminal attached to the debug container upon creation.
- **Built-in OpenShift login** *(opt-in — enable under Settings → Kubernetes & Debug → "Enable OpenShift Support")* — authenticate against an OpenShift cluster without leaving the Connection Manager: paste a full `oc login ...` command (e.g. the one copied from the OpenShift Web Console's "Copy Login Command" button) or enter the server URL and token manually. A local `oc` CLI shim is added to `PATH` for local shell tabs (`oc login`/`whoami`/`project`), so `oc` works there even without the real OpenShift CLI installed.
- **Live kubeconfig watching** — `~/.kube/config` is watched for changes on disk, so a new cluster or context (from a fresh `oc login`, `kubectl config use-context`, or another tool) appears in the cluster tree automatically, without restarting the app.
- **Pod Inspector & Detailed Status** — Inspect complete pod metadata, container states, restart counts, conditions, YAML manifests, and live cluster events in a dedicated modal.
- **Port Forwarding** — Forward ports from remote pods or services to localhost with background lifecycle management and status tracking.
- **Zero startup impact** — The `@kubernetes/client-node` engine is lazy-loaded on first actual use, preserving instant desktop application startup.

> [!TIP]
> For a comprehensive walkthrough of Kubernetes features, file access mechanics, and technical constraints in ephemeral containers, see the **[Kubernetes & OpenShift Guide](docs/KUBERNETES.md)**.

### X11 & GUI forwarding (Windows & Linux)
- **Seamless X11 Forwarding (`-Y`)** — Run remote Linux GUI applications (e.g. `xclock`, `gedit`, `firefox`, IDEs) through SSH directly to your local desktop with trusted X11 forwarding (`ForwardX11Trusted=yes`).
- **Built-in / Bundled X Server for Windows (MobaXterm-style)** — Windows installer packages a fully portable VcXsrv X server. Automatically managed in multiwindow rootless mode (`:0 -multiwindow -clipboard -wgl`) so remote Linux windows appear seamlessly on your Windows taskbar with Alt+Tab and clipboard synchronization. Access control is deliberately left **on** (no `-ac`): only clients presenting the `MIT-MAGIC-COOKIE` that `ssh -X`/`-Y` already negotiates can connect, so the port being reachable on your LAN (for the firewall rule below) doesn't mean anyone on it can hijack forwarded windows.
- **Zero-configuration Windows Firewall** — The Windows installer automatically configures a Windows Defender Firewall rule for the bundled X server, so you never get interrupted by firewall prompts.
- **Configurable X Server Modes** — Choose under Settings → Terminal:
  - *Auto-start (Default)*: Starts the local X server on-demand only when opening an SSH session with X11 forwarding enabled.
  - *Always Running*: Keeps the X server running in the background while sshs3 is open.
  - *Manual / External*: Use an external X server (e.g. WSLg, manual VcXsrv, or Xming) or custom binary path/arguments.
- **Live reachability checks** — Automatic detection of whether an X server is listening on the target display (port 6000+), with real-time status indicators in both connection profiles and settings.

### FIDO2 & Hardware Security Keys (YubiKey)
- **Native FIDO2 / WebAuthn resident credential support** — Discover resident (discoverable) keys directly from connected FIDO2 hardware tokens (`ykman` / `ssh-keygen -K`) and generate fresh `ed25519-sk` and `ecdsa-sk` credentials with PIN/User Verification (UV) and touch policies.
- **Visual touch presence banner** — An unobtrusive in-app banner prompts you whenever your security key requires physical touch verification (*"Touch your security key to authenticate"*), eliminating mystery terminal hangs.
- **Resident and non-resident keys** — Seamlessly use both standard security key files (`id_ed25519_sk`, `id_ecdsa_sk`) and hardware-resident credentials without complex command-line setup.
- **Global agent & startup unlock** — Optionally unlock and load FIDO2 resident keys into an isolated, managed agent at startup with a single PIN verification.
- **Multiplexed dotfiles sync over FIDO2** — Uses OpenSSH connection multiplexing (`ControlMaster`/`ControlPath`) for background dotfiles sync, allowing files to be synchronized over existing FIDO2 sessions without requiring extra physical touches.

### Smartcard & PKCS#11 authentication
- Built-in support for **SITHS cards**, **Net iD**, **OpenSC**, **YubiKey PIV (libykcs11)**, and **p11-kit**, with automatic detection of installed PKCS#11 modules on Linux and Windows.
- A local **Askpass server** intercepts OpenSSH's PIN prompts over a loopback socket and surfaces them as an in-app PIN dialog, instead of falling back to a terminal prompt or failing silently.
- **PIN caching modes** — one setting under Settings → Security & Smartcard, applied uniformly to every smartcard profile (no per-profile override, since almost everyone has a single physical card and mixing modes for the same card can cause the same PIN to be asked for redundantly, or reintroduce PKCS#11 reader contention between differently-scoped agents):
  - **Always Prompt** *(default)* — no caching across connections: reconnecting always asks for the PIN again. On Linux/macOS, the interactive terminal and a dotfiles-sync connection (if enabled) each prompt for their own PIN separately. On Windows, both share one PIN entry for that connection instead (see the platform note below) — reconnecting still asks again either way. Use this where policy requires re-authenticating the card on every login.
  - **Once Per Terminal Connection** — the PIN is entered once into a private, app-managed `ssh-agent` shared by that terminal tab and its dotfiles sync, so opening one tab means one prompt even with dotfiles sync on. The agent is scoped to that terminal, not the app: it's killed the moment the terminal disconnects, and reconnecting — even within the same app run — asks for the PIN again. Auto-reconnects on a dropped connection *do* reuse the still-open agent, so a flaky network doesn't repeatedly ask for the PIN either.
  - **Global (App Lifetime)** — the PIN is entered once per physical card and shared by every terminal and profile using it, for as long as the app keeps running — including local shell tabs opened afterwards (see **SSH agent lifecycle management** above), not just SSH profile connections. Most convenient, least strict: the card stays usable by anything in the app until you quit or lock it manually. A **card icon in the top bar** (shown only while this mode is active) opens a popover listing exactly what's currently cached — each unlocked PKCS#11 library and the certificate label(s)/key type it's holding, queried live from the agent — with a **Lock All Now** button to clear it on demand. Each identity can be expanded to show its certificate's Subject, UPN (Microsoft's `otherName` SAN, common on PIV/CAC/SITHS cards), and validity period, read directly from the PKCS#11 module rather than a vendor-specific CLI tool — so it works the same regardless of which PKCS#11 provider (OpenSC, Net iD, libykcs11, p11-kit) is behind the card. Certificate details are cached once at agent load to avoid repeated PKCS#11 reader polling that can race live sessions and crash sensitive tokens (e.g. Net iD).
    - **Unlock smartcard at app startup** *(opt-in, only shown/effective in this mode)* — prompts for the PIN as soon as the app opens instead of waiting for the first connection that needs it, so the card is already unlocked by the time you open your first terminal — including a local shell tab, which otherwise wouldn't trigger any smartcard prompt on its own. Prefers **p11-kit** whenever it's among the detected libraries (it proxies every other registered PKCS#11 module, so e.g. `p11-kit-proxy.so` and `opensc-pkcs11.so` coexisting is one physical card reachable two ways, not two cards to pick between); otherwise only acts when exactly one non-p11-kit library is detected, doing nothing rather than guess when there are several unrelated candidates.
  - On Linux/macOS, **Global** keeps every unlocked card and FIDO2 key in **one app-wide private `ssh-agent`** on a stable socket (`$XDG_RUNTIME_DIR/sshs3/agent.sock`, in a 0700 directory; `agent-<pid>.sock` if another app instance owns it). The app's own SSH/SFTP connections through it are pinned to the profile's card with `IdentitiesOnly` and a public key file (`-i <key>.pub`), so the server never sees every unlocked card's keys. The lock icon makes the agent forget all keys but leaves it running; the same button reads **Unlock Now** when nothing is unlocked and unlocks them again on demand (PIN prompt) without restarting the app. For FIDO2 keys that require PIN + touch on every signature, the PIN entered at unlock is kept in memory only (never on disk) and replayed for signatures until you lock, so connecting asks only for the touch. The other two modes spawn a private `ssh-agent` per terminal/connection. None of them uses the process's inherited `SSH_AUTH_SOCK` — loading a smartcard into the desktop's own agent (GNOME Keyring, KWallet, …) was found to make the OS prompt for the PIN independently, outside sshs3's own dialog, and to leave the card usable by other applications. Loading the card is retried a few times with a short backoff without re-prompting, since most PIV/CAC readers only support one active transaction at a time and a stray concurrent PKCS#11 session can transiently collide with it; the user is only ever asked for the PIN once per agent load.
  - On **Windows**, there's no equivalent of a caller-spawned private agent: Win32-OpenSSH's `ssh-agent.exe` only runs as the single system-wide "OpenSSH Authentication Agent" service, bound to the fixed pipe `\\.\pipe\openssh-ssh-agent`, and refuses to start a second independent instance. All three modes there — including **Always Prompt** — load the card into that shared service pipe via `ssh-add -s` instead of a direct `-I` login (requires the service to be enabled: `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent`, once, as Administrator — the installer offers to do this; see [Windows vs. Linux](#windows-vs-linux-differences-limitations--workarounds)), and evict just that card afterwards via `ssh-add -e` rather than killing a process they don't own. This isn't optional on Windows: Win32-OpenSSH's `ssh-pkcs11-helper` subprocess doesn't reliably route a smartcard PIN prompt through sshs3's askpass server the way it does for a plain account password, so a direct `-I` login there silently falls through to a Windows account password prompt instead of ever asking for the card's PIN.

### Dual-pane file manager
- Two independent panes, each pointed at local disk, SFTP, S3, or Kubernetes container filesystems, with drag-and-drop between panes and to/from the OS file manager.
- **In-app text file editor & live Markdown preview** — edit files directly across local disk, SFTP, S3, and Kubernetes pod files with a dedicated **Edit/Preview toggle and live Markdown preview** for `.md`/`.markdown`/`.mdx` files (rendered with `react-markdown` + `remark-gfm` with GitHub Flavored Markdown tables, checklists, and code formatting, lazy-loaded for zero app bundle bloat).
- **File clipboard** — copy (`Ctrl+C`), cut (`Ctrl+X`, with visual dimming of the cut item), and paste (`Ctrl+V`) files and folders via keyboard or the context menu.
- **Directory navigation history** — back/forward toolbar buttons, `Alt+Left`/`Alt+Right`, and mouse back/forward buttons to retrace recently visited folders.
- **Spring-loaded folders & drag auto-scroll** — hovering a dragged item over a folder row or breadcrumb segment for ~900ms navigates into it automatically, and the file list auto-scrolls when dragging near its top/bottom edge.
- **Desktop keyboard reflexes** — `F2` to rename, `F5` to refresh, `Alt+Up` to go to the parent directory, and `Escape` to cancel an in-progress drag.
- **Directory synchronization (Folder sync & diff)** — Diff and synchronize any two folders across local disk, SFTP, and S3 (including remote↔remote):
  - Size and modification time (`mtime`) diff engine with New, Changed, and Target-Only categorizations.
  - Interactive file comparison (**Compare**) to review differences before applying.
  - Selective sync execution with optional deletion of destination-only files.
  - Preserves original modification times on local disk and SFTP targets (`setModifiedTime`).
  - Save and re-run directory sync pairs as reusable named profiles.
- **File content search (`Ctrl+Shift+K`)** — Deep text and regex search across files on local storage, SFTP servers, and S3 buckets, with live match previews, click-to-open, and responsive background cancellation.
- **Live log streaming (`tail -f`)** — Follow growing files in real-time from SFTP or local disk in an embedded viewer pane with pause/resume, search, and auto-scroll.
- **Background transfer queue** with per-job progress, pause/resume/cancel, and live directory-scan feedback before large folder transfers start.
- **Conflict resolution** dialog (overwrite / skip / rename-with-`(1)`-suffix), with an "apply to all remaining" option.
- **Permissions editor (chmod)** — graphical read/write/execute grid per owner/group/other, octal input, recursive apply — for SFTP and local files.
- Properties, tags, and quick in-pane filtering (`Ctrl+F`).
- **File & path shortcuts** — Quick actions to copy filenames or full local/remote locations, and duplicate items.
- **Type-ahead search**: start typing anywhere in a focused pane to jump to and select the first matching file/folder (Explorer/Finder-style), independent of the `Ctrl+F` filter.
- **"Open in Terminal"** from an SFTP pane, landing directly in the browsed directory.
- **Git repository integration & branch status** — Live branch indicator, clean/modified/untracked indicators, commit status (ahead/behind counts), Git Pull, and "Open in GitHub/GitLab" directly in SFTP and local pane toolbars and context menus. Includes **Git Clone to here / inside...** with branch and shallow clone options. Can be switched on/off globally under *Settings → Git & GitHub*.

### S3 & object storage
- **AWS S3**, **MinIO**, **NetApp StorageGRID**, and any other S3-compatible endpoint, with custom endpoints, region selection, path-style addressing, and self-signed CA support.
- **AWS SSO (IAM Identity Center) login** — sign in through the same OIDC device-authorization flow as `aws sso login`: approve once in your browser, then pick an account and role from the list sshs3 fetches for you. Issues short-lived, browser-approved credentials for an S3 profile instead of a long-lived static access key/secret pair.
- **Bucket/object tagging**, a **bucket policy editor**, **CORS configuration**, and **object versioning** (list, restore, delete specific versions).

### Networking, proxies & SSH tunnels
- **Jump Host / ProxyJump (`-J`)** for both the terminal and SFTP, to reach hosts behind a bastion.
- **SSH agent forwarding (`-A`)**, toggled per profile under Advanced SSH Options, for hopping onward to another host using keys/cards held by your local agent instead of copying keys to the remote.
- **Port forwarding**: local (`-L`), remote (`-R`), and dynamic SOCKS (`-D`) tunnels per profile.
- **Outgoing proxy** support (HTTP, SOCKS4, SOCKS5) with authentication, used for both SFTP and S3 connections.
- **Advanced SSH options**: compression, `ServerAliveInterval`, and custom ciphers/KEX algorithms/MACs for older or hardened servers.
- **Host key verification (TOFU)** — SFTP runs over the system OpenSSH client, so host keys are checked against your `~/.ssh/known_hosts`. An unknown key opens sshs3's interactive trust dialog (showing key type and fingerprint); with no window to ask in, the key is rejected. A *changed* key is refused outright by OpenSSH, with no prompt.
- **System trust store integration** — S3/TLS connections trust your OS's CA bundle (Windows certificate store via `win-ca`, or the Linux distro's CA bundle), so internal/corporate certificate authorities work without extra configuration.

### Dotfiles pool sync *(opt-in)*
- Define a reusable pool of files (`.bashrc`, `.vimrc`, etc.) and assign it to specific SSH profiles.
- On connect, a short-lived background SFTP check compares the pool against the live server and, depending on the profile's policy, either shows a non-blocking banner to review and apply the diff, or updates silently.
- Disabled by default at two levels: a global settings switch, and a per-host pool/policy assignment — nothing runs until both are explicitly turned on.
- **Git dotfile repository import**: clone or import dotfiles directly from any Git repository URL into a dotfile pool.

### Git & GitHub / GitLab integration
- **Developer SSH Keys & Git Providers (`Settings → Git & GitHub`)** — Centralized hub to discover developer keys across `~/.ssh`, active SSH agents, and unlocked smartcard/hardware token caches.
- **One-click GitHub & GitLab key registration** — Copies your public key to clipboard and launches your browser directly to GitHub (`/settings/ssh/new`) or GitLab (`/-/user_settings/ssh_keys`) prefilled with your key title.
- **Cryptographic SSH Git commit signing (`~/.gitconfig`)** — Configure `user.signingKey`, set `gpg.format = ssh`, toggle `commit.gpgsign`, and maintain `~/.ssh/allowed_signers` for local signature verification with a single click. Supports custom key strings and automatic signing enforcement.
- **Git remote key lookup (`username.keys`)** — Query public SSH keys for any user on GitHub, GitLab, or self-hosted GitLab instances.
- **Dual-pane Git operations** — Git Clone, Git Pull, and repository status polling across local and remote SFTP sessions.
- **SFTP & File Manager Git Integration toggle** — Toggle Git detection and actions in SFTP and local file manager panes on or off under *Settings → Git & GitHub*.


### Remote profile sync *(opt-in, "own your data")*
- Back up and sync connection profiles, dotfile pools, saved directory-sync profiles, and app settings to your own S3 bucket or SFTP server — no sshs3-operated cloud service involved.
- **Zero-knowledge, client-side encryption**: everything is encrypted with AES-256-GCM (scrypt-derived keys) before it's uploaded.
- **Single master password with optional separate keys**: choose one master password by default for fast, simple setup and unlock. Advanced users can toggle "Use separate passwords" to keep a topology password (hostnames, ports, and folder hierarchy) distinct from a credentials password (usernames, saved passwords, API keys, dotfile contents). Neither password, nor the keys derived from them, ever leaves the device.
- **Smartcard & hardware token unlock (PKCS#11 / SITHS / YubiKey)**: link a detected hardware smartcard or token to your remote sync vault. Unlocking sync requires only entering your smartcard PIN — the hardware token signs a challenge cryptographically to verify possession and unlock the local session without typing master passwords. Linking a card so it can *derive* the wrapping key itself (never storing your master passwords, not even encrypted) requires an **RSA or Ed25519** key: those schemes sign deterministically, so the same card reliably reproduces the same key. **ECDSA** cards (the most common on PIV/CAC) sign with a fresh random nonce each time and can't reproduce a stable key, so that specific passwordless-link mode is refused for them — unlock with your master passwords once instead, then link the card to cache the unlock, not to derive the key from scratch.
- **Automatic synchronization (Auto-sync changes)**: an optional toggle under Settings → Synchronization debounces and automatically pushes local updates (profiles, dotfiles, settings) to your remote target whenever changes occur, and pulls remote changes every 10 minutes in the background — so multiple machines stay up to date without manually clicking Push/Pull. If sync is locked when a background push/pull is due and a smartcard is linked, it's unlocked automatically via the same PIN dialog as a manual unlock (never a text master-password prompt on its own); a declined or failed attempt is throttled for 5 minutes rather than re-prompting on every change. Re-unlocking sync manually (password or smartcard) also immediately flushes any changes that piled up while it was locked, instead of only pulling.
- **Per-record merge, not overwrite**: pulling changes reconciles each profile/dotfile individually by last-edited timestamp (with tombstones so deletions propagate correctly too), so two machines edited independently don't clobber each other.
- **Generates a managed block in `~/.ssh/config` from your SSH profiles** (host/port/user/identity file/proxy jump/etc.) on every push — and, independently of remote sync, keeps it up to date locally on startup and whenever you save, delete or import an SSH profile (turn off under **Settings → Keep `~/.ssh/config` in sync**) — so a plain `ssh <alias>` typed in any terminal — inside or outside sshs3 — connects with the same settings as the matching profile; also appends new entries to `~/.ssh/known_hosts`. Everything else in those files is left untouched, secrets are never written, directives that could execute code (`ProxyCommand`, `LocalCommand`, `Match`, `Include`, …) are always stripped before writing, and a host-key mismatch between machines is surfaced as a conflict rather than ever auto-resolved.
  - **Unlocked cards work in any terminal.** Under **Global** PIN caching, while a smartcard or FIDO2 key is unlocked in the app, sshs3 also keeps a second, **local-only** block (`# BEGIN sshs3-agent … # END sshs3-agent`, never synced, placed just before the managed block) that points those hosts at the app-wide agent: `IdentityAgent <socket>`, `IdentityFile <card's .pub>`, `IdentitiesOnly yes`, `PKCS11Provider none`. ssh uses the first value it finds, so a plain `ssh <alias>` in any terminal (also IDEs and other terminal emulators) signs with the unlocked key and asks for no PIN. Lock the card, quit the app or leave Global mode and the block is removed, and ssh falls back to the managed block's `PKCS11Provider` (which asks for the PIN itself). If the app crashes the block can be left pointing at a dead socket until sshs3 is started again (it cleans up on startup). Not on Windows.
- **"Import existing profile from the cloud"** bootstraps a brand-new machine straight from an already-configured sync target.
- **Clear, specific error messages** instead of raw IPC/exception text — a wrong master password, a push/pull conflict, a failed smartcard signature check, and common connection failures (refused, DNS, timeout, auth) each surface their own plain-language explanation.
- **Delete all sync data** (Danger zone, in the Synchronization panel): permanently deletes the encrypted sync files from the remote target and clears the sync target/salts/smartcard link from this device — with an explicit, itemized warning of what is and isn't affected before you confirm. Never touches local SSH/S3 profiles, dotfile pools, or settings.
- Configured under Settings → Synchronization.

### Profiles & security
- Organize SSH and S3 profiles into folders/groups, with quick filtering and "recently used" ordering.
- All secrets (passwords, SSH passphrases, S3 keys) are encrypted at rest via Electron's `safeStorage`, backed by the OS keyring (libsecret on Linux, DPAPI on Windows, Keychain on macOS).

### Customization
- Dark, light, Breeze, and system-following themes.
- Configurable terminal font family/size with a live preview.
- Optional performance bar above terminals (layout, metrics and interval under **Settings → Performance**).
- Fully rebindable keyboard shortcuts with interactive key-capture and a reset-to-default option.

---

## How it works

sshs3 is a standard three-process Electron application, kept deliberately thin: the main process owns every privileged operation, and the renderer only ever talks to it through a typed IPC contract.

```
renderer (React, sandboxed, no Node access)
   │  window.multissh.*  (exposed by the preload script via contextBridge)
   ▼
preload  (src/preload) — thin wrapper around ipcRenderer.invoke/on
   ▼
main process (src/main) — IpcBridge routes every channel to a dedicated service
```

- **`IpcBridge`** (`src/main/IpcBridge.ts`) is the single entry point for all `ipcMain.handle` registrations. It doesn't implement logic itself — it wires typed IPC channels (defined once in `src/shared/types/ipc.ts`, shared between main, preload, and renderer) to the services below, and also drives a few main→renderer "prompt" flows (host-key trust, transfer conflicts, dotfiles sync) where the main process needs an answer from the user before it can continue.
- **Terminal sessions** (`SSHPtyManager`, on top of `node-pty`) spawn the real `ssh` binary as a pseudo-terminal process rather than reimplementing the SSH protocol, which is what makes existing `~/.ssh/config` files, agents, and CLI muscle memory work unmodified. Local shell tabs use the same manager to spawn `$SHELL`/`cmd`/PowerShell instead.
- **File transfers** go through a separate path: SFTP spawns the system `ssh -s sftp` and speaks SFTP v3 over its stdin/stdout (`src/main/storage/sftp/`: `SftpPacketProtocol`, `SftpStreams`, `OpenSshSftpProcess`, wrapped by `OpenSshSftpClientAdapter`), and S3 uses `@aws-sdk/client-s3`, behind a common `IStorageProvider` interface (`src/main/storage/`) implemented by `LocalStorageProvider`, `SFTPStorageProvider`, and `S3StorageProvider`. This abstraction is what lets the dual-pane file manager copy transparently between local disk, SFTP, and S3 without caring which side is which. Transfers themselves run through a `TransferPipeline`/`TransferQueue` pair that streams data with pause/resume support and progress events, rather than buffering whole files in memory.
- **Smartcard auth** (`SmartcardDetector`, `AskpassServer`) detects installed PKCS#11 modules on disk and, when a smartcard profile connects, starts an isolated IPC askpass server (a mode 0700 Unix domain socket on POSIX, a token-authenticated 127.0.0.1 TCP server on Windows) that OpenSSH's askpass mechanism talks to for the PIN prompt, relayed to an in-app dialog.
- **Smartcard PIN caching** (`SmartcardAgentLoader`, plus agent bookkeeping in `IpcBridge`) implements the three caching modes described above. `loadSmartcardIntoPrivateAgent` spawns an agent via `AgentLifecycleManager.spawnPrivateAgent()` — on Linux/macOS a fresh, private `ssh-agent` (deliberately never the inherited `SSH_AUTH_SOCK`); on Windows the shared "OpenSSH Authentication Agent" service pipe, since Win32-OpenSSH has no private-agent equivalent — loads the card into it via `ssh-add -s`, and retries the mechanical load (not the PIN prompt, which is cached after the first ask) a few times on failure to absorb transient PKCS#11 reader contention. `IpcBridge` then either scopes that agent to one PTY session (evicted in the `SSHPtyManager`/`IpcBridge` exit handlers), or caches it in a `pkcs11LibPath`-keyed map for the app's lifetime ('agent-global' mode, cleared on quit or via the top-bar lock action). The interactive terminal authenticates through the cached agent instead of a second direct `-I` login — on Linux/macOS via OpenSSH's `IdentityAgent` option, on Windows via the `SSH_AUTH_SOCK` environment variable instead, since Win32-OpenSSH 9.5p2's `IdentityAgent` config value cannot resolve a raw named-pipe path (confirmed directly: it fails with `ssh_get_authentication_socket: No such file or directory` even though the identical pipe works via the env var). The same caching resolution runs for the file manager's own SFTP connections (`STORAGE_CONNECT`) and for the dotfiles-sync connection, so a smartcard SFTP profile reuses the cached agent instead of opening a second, independent PKCS#11 session against the same reader — which most PIV/CAC readers reject with "agent refused operation" since they only allow one transaction at a time. It falls back to loading its own short-lived agent only when no cached one is available (e.g. 'always-prompt' mode). **Global** mode does not spawn an agent per card: `AppAgent` (`src/main/ssh/AppAgent.ts`) owns one long-lived `ssh-agent` on a stable, permission-checked socket plus an askpass server that answers prompts the agent raises later (e.g. a `verify-required` FIDO2 signature); `addSmartcardToAgent`/`addFido2ResidentKeysToAgent` run the same retry/PIN/touch logic against it, each load with its own temporary askpass server so a signature prompt can never be answered with a load's PIN. `IpcBridge` tracks which key fingerprints each unlocked card contributed (`globalCards`) to group identities in the cached-identities list, to pick the right key for Remote Profile Sync, and to write the public key files (`agentIdentityFiles`) that `SmartcardDetector.buildSSHArguments` turns into `IdentitiesOnly` + `-i`.
- **`AgentLifecycleManager`** probes for a running `ssh-agent` (or the Windows OpenSSH Authentication Agent service) via `ensureAgent()` and spawns/manages one itself (`ssh-agent -s`) if none is found, caching the result so key-based auth works even if the user hasn't started an agent manually. Concurrent callers (e.g. the app's own startup call racing a session-restored local shell tab creating its PTY immediately) all await the same in-flight attempt rather than each getting an independent, possibly-stale status — a caller that raced the first invocation and got a premature snapshot would otherwise silently end up with no agent at all, since a PTY's environment is fixed at spawn time and can't be corrected after the fact. It also exposes `spawnPrivateAgent()`/`killPrivateAgent()`/`unloadCard()`, used exclusively by the smartcard PIN caching above — `unloadCard()` (`ssh-add -e`) is how a caller evicts just its own card from an agent it doesn't own outright, such as the Windows service pipe. `IpcBridge`'s `TERMINAL_CREATE` handler and `SSHPtyManager` set a local shell's `SSH_AUTH_SOCK` according to the `localTerminalAgentMode` setting (`auto` | `system` | `disabled`; `app-managed` is a legacy alias of `auto`). In `auto` under 'agent-global' PIN caching the app-wide agent (`AppAgent`) always wins — even while it is still empty, so a card unlocked later is usable from shells that are already open — otherwise `ensureAgent()` returns the app's running agent, then the inherited `process.env.SSH_AUTH_SOCK` (backfilled from the login shell by `LoginShellEnv`, which also covers `SSH_AGENT_PID`), and only spawns one if none exists. `system` takes only the inherited socket if it exists; `disabled` deletes both variables, even if the caller's `env` tries to set them.
- **`AwsSsoAuthService`** drives the AWS SSO OIDC device-authorization flow (client registration → device code → browser approval → token polling), caching the client registration and issued token the same way the AWS CLI does under `~/.aws/sso/cache`, then uses `@aws-sdk/client-sso` to list accounts/roles and mint short-lived credentials for an S3 profile.
- **Remote profile sync** (`SyncCryptoService`, `ProfileSyncService`, `SyncConfigStore`, `SshNativeFileMerger`) is a separate, opt-in layer on top of the same `IStorageProvider` used by the file manager: it derives two AES-256-GCM keys via scrypt (one per master password), splits each profile into a non-secret "topology" half and a secret "credentials" half before encrypting them into separate files, and merges pulled data back in per-record by timestamp rather than overwriting local state wholesale. `~/.ssh/config`/`known_hosts` handling lives in its own pure-text-merge module, kept deliberately separate from the JSON-record merge logic since they're real files shared with the system's own SSH client.
- **Kubernetes & OpenShift** (`K8sDiscoveryService`, `K8sTerminalManager`, `K8sLogManager`, `src/main/services/k8sClient.ts`) — `K8sDiscoveryService` loads kubeconfig contexts and lists namespaces, pods, and containers on demand, and watches `~/.kube/config` on disk (`fs.watch`) to pick up new/changed contexts without an app restart. `K8sTerminalManager` handles interactive container exec sessions via the Kubernetes WebSocket exec protocol, forwarding stdin/stdout through the standard terminal IPC event interface. `K8sLogManager` streams container logs using `@kubernetes/client-node` with custom uncaught-exception guards around abort signals to protect against upstream stream pipeline drops. **`K8sAuthService`** parses a pasted `oc login ...` command (or manual server/token entry) and authenticates directly against the OpenShift/Kubernetes API to update the kubeconfig, and **`K8sShimManager`** maintains a small `oc` CLI shim script (`~/.sshs3/bin`) prepended to local shell tabs' `PATH`, gated behind the opt-in "Enable OpenShift Support" setting.
- **Directory synchronization** (`DirectorySyncService`) — compares source and destination directory trees across any pair of `IStorageProvider` instances (local disk, SFTP, S3) using file sizes and timestamps (`mtime`), generates diff reports, and drives batch file transfers and deletions with optional mtime preservation on supported providers.
- **File content search & log tailing** (`LocalContentSearchService`, `RemoteSearchService`, `FileTailService`) — provides streaming regex/text search within files across local directories, remote SFTP hosts, and S3 bucket prefixes, as well as live `tail -f` streaming for active log files.
- **Smartcard certificate decoding** (`SmartcardCertificateReader`, `CertificateParser`) — direct PKCS#11 session inspector using native `pkcs11js` bindings to parse X.509 certificates, Subject names, and DER-encoded UPN extensions without relying on external utilities, cached on agent load to avoid hardware contention.
- **`SystemTrustStore`** reads the OS's CA bundle (via `win-ca` on Windows, or the known Linux distro bundle paths) at startup so S3/TLS connections to internally-issued certificates succeed without manual CA configuration.
- **Persistence** (`ProfileStore`, `SettingsStore`, `SessionStore`, `DotfilePoolStore`, `SyncConfigStore`) is all flat JSON under Electron's per-OS `userData` directory, written through a serialized mutation queue to avoid concurrent-write corruption, with secret fields passed through `safeStorage` before hitting disk.
- **Dotfiles sync** (`DotfileSyncService`) opens its own short-lived SFTP connection — separate from the interactive PTY session — to diff and, on approval, atomically write (`temp file + rename`) pool files to a host.
- **Git & GitHub services** (`GitConfigService`, `GitStatusService`, `RemoteGitService`, `GitKeyFetcher`, `DotfileGitImporter`) — manage Git commit signing (`gpg.format=ssh`, `user.signingKey`, `commit.gpgsign`, `~/.ssh/allowed_signers`), query repository status and run Git commands (`git pull`, `git clone`) locally or over remote SFTP hosts, fetch public keys via `username.keys`, and import dotfiles directly from Git repositories.

---

## Security & Privacy: Private Keys, PINs & Credentials

sshs3 is engineered around strict zero-knowledge principles and the principle of least privilege. When managing production infrastructure, bastion jump hosts, cloud buckets, and cryptographic hardware, you need absolute clarity and confidence in how your credentials and authentication secrets are handled.

### 1. Hardware Security Keys & Private Keys (Zero Extraction)
- **Hardware tokens (YubiKey, PKCS#11, SITHS, Net iD, FIDO2 / WebAuthn):** Your private keys reside exclusively inside the secure cryptographic chip (Secure Element) of the physical token. **Private keys never leave the hardware device.** They cannot be extracted, exported, or read by sshs3, the operating system, or malicious software. All cryptographic operations (such as SSH challenge signatures) are executed directly on the physical token hardware.
- **Disk-based SSH keys (`~/.ssh/id_*`):** sshs3 delegates authentication directly to your system's native OpenSSH client (`node-pty`) or your active `ssh-agent`. sshs3 does not copy, duplicate, inspect, or upload your private key files.
- **No telemetry / No tracking:** sshs3 does not track you. It transmits zero analytics, zero crash telemetry, and zero credentials to any external servers.

### 2. PIN Codes & Passphrases (Ephemeral & Never Stored)
When unlocking a smartcard, YubiKey, or passphrase-protected SSH key, OpenSSH communicates with sshs3's in-app askpass mechanism:
- **Zero Filesystem Storage:** PIN codes, passphrases, and unlock passwords are **never written to the filesystem, configuration files, cache directories, or temporary files**.
- **Zero Memory Caching:** The user's PIN is transferred from the in-app modal directly into the active prompt callback, piped to the OpenSSH child process via standard input, and immediately discarded and garbage-collected. The application process does not retain PIN strings in memory once the authentication step has completed.
- **Strictly Redacted Logging:** Diagnostic logging strictly redacts all sensitive content: only the prompt metadata and string length are logged (e.g., `resolved prompt "Enter PIN" -> 6 char(s)`), ensuring that plaintext PINs or passphrases never appear in stdout, stderr, or debug logs.
- **Isolated Inter-Process Communication:**
  - **Linux & macOS:** The askpass server uses an isolated Unix domain socket located in a private directory created with strict POSIX mode `0700` (accessible exclusively by your own operating system user account).
  - **Windows:** The askpass server binds to `127.0.0.1` protected by a cryptographically random 128-bit authentication token verified using constant-time comparison (`crypto.timingSafeEqual`) to protect against timing side-channel attacks.

### 3. Stored Credentials & Secrets Encryption at Rest
- **Operating System Keyring Encryption:** When you choose to save passwords or S3 secret keys in a connection profile, sshs3 encrypts those secret fields before writing to disk using Electron's `safeStorage` API:
  - **Linux:** Encrypted via `libsecret` (GNOME Keyring / KWallet).
  - **Windows:** Encrypted via DPAPI (Data Protection API, hardware- and user-bound).
  - **macOS:** Encrypted via Apple Keychain.
- **Zero-Knowledge Profile Sync:** If you opt in to sync your connection profiles to your own S3 bucket or SFTP server, profiles are split and client-side encrypted using **AES-256-GCM** with keys derived via `scrypt` from your master password (or hardware token). The remote storage server only ever receives encrypted ciphertext.

---

## Jump hosts & tunnels explained

sshs3 has two independent mechanisms for reaching a host behind a bastion, and it's easy to mix them up because both ultimately rely on OpenSSH's jump-host machinery. This section covers every variant.

### 1. ProxyJump — reaching a host directly through a bastion

Use this when you want a **terminal or SFTP session on the destination host itself** (e.g. `web01`, which is only reachable from `jumpbox`) — no separate connection to the bastion is opened or kept around.

Each profile has a **Jump Host / ProxyJump** setting with two variants:

- **Reference a saved profile** *(recommended)* — pick another profile you already have (e.g. your `jumpbox` profile) from the dropdown in the profile editor. sshs3 resolves it to `user@host[:port]` at connect time using that profile's own connection fields, so you never retype credentials and the jump target stays correct if the jumpbox profile is later edited. Internally this is `proxyJumpProfileId`, resolved by `resolveProxyJumpTarget()`/`withResolvedProxyJump()` (`src/main/ssh/resolveProxyJump.ts`).
- **Custom (enter manually)** — a raw `user@host[:port]` string, for a bastion that isn't itself a saved profile in this app (e.g. a shared/external jump box).

If both are somehow present, the referenced profile always wins over the manual string.

This works for both connection types, through two different underlying mechanisms:

- **Terminal sessions** spawn the real `ssh` binary, so the resolved target is passed straight through as `-J user@host[:port]` (`SmartcardDetector.buildSSHArguments()`), and OpenSSH itself handles the hop.
- **SFTP sessions** also spawn the real `ssh` binary (`ssh -s <host> sftp`), so the same `-J` argument is used and OpenSSH handles the hop. This applies to every place an `SFTPConfig` is built from a profile (the file manager, directory sync, pane auto-reconnect on startup), all of which forward `proxyJumpProfileId`/`proxyJump` the same way.
- **Exported `~/.ssh/config`** (kept in sync locally, and via remote profile sync) writes a real `ProxyJump <alias>` pointing at the referenced profile's own exported `Host` alias, not a frozen string — so it keeps working outside sshs3 (plain `ssh web01` in any terminal) and stays in sync if the jumpbox profile's host/port/user changes.

**Known limitation — shared credentials across hops:** OpenSSH's built-in ProxyJump reuses whatever identity/agent (`IdentityAgent`, loaded smartcard, key file) is already active for the outer connection for *both* hops. There's no per-hop credential selection — if `jumpbox` and `web01` genuinely need different keys or a different smartcard, you're relying on your local agent already holding both, the same as you would on the plain `ssh -J` command line.

### 2. SSH Tunnels panel — port forwarding as its own, independent thing

Use this when you want a **standalone forwarded port** — a SOCKS proxy for your browser, or a local port that forwards into an internal service — that exists on its own, independent of whether or when you happen to open a terminal.

Tunnels are managed entirely from the **Tunnels panel** (not the profile editor, which only edits connection fields). Each tunnel has:

- Its **own name** (e.g. `jumpbox-socks`, `prod-db`), independent of the underlying profile's name — set once, shown everywhere the tunnel is listed.
- A **profile** it uses to establish the underlying SSH connection (can be the same profile you also open terminals to — that's fine, they're unrelated).
- A **type**:
  - **Local (`-L`)** — forward a local port to a host/port reachable from the far end (the classic "reach an internal service through a bastion" tunnel).
  - **Remote (`-R`)** — forward a port on the remote host back to something reachable from your machine.
  - **Dynamic / SOCKS (`-D`)** — turn the local port into a SOCKS4/5 proxy, routing arbitrary outbound traffic (e.g. a browser configured to use it) through the tunnel's SSH connection.

Tunnels started from this panel run as their own background `ssh -N` process (`SSHTunnelManager`), tracked independently of any terminal.

**Terminals never auto-start a profile's tunnels.** Earlier versions did — opening any terminal against a profile with saved tunnels would silently re-establish them, which is what caused `Address already in use` errors when the Tunnels panel had already started the same port. Now, opening a terminal only ever opens a terminal; starting/stopping a tunnel is always an explicit action in the Tunnels panel.

### Putting it together: reaching `web01` behind `jumpbox`

- **Just need a shell on `web01`?** Create a `web01` profile with `proxyJumpProfileId` pointing at your `jumpbox` profile. Open a terminal on `web01` directly — no separate connection to `jumpbox`, no tunnel involved.
- **Need a SOCKS proxy or a forwarded port that outlives any one terminal?** Create a tunnel in the Tunnels panel using your `jumpbox` profile as the underlying connection, name it, pick Local/Remote/Dynamic, and start it from the panel. Opening a terminal to `jumpbox` (or `web01`) afterwards won't touch it.
- **Both at once?** No conflict — a terminal to `web01` (via ProxyJump) and a SOCKS tunnel through `jumpbox` (via the Tunnels panel) are entirely independent connections that can run side by side.

---

## Built on open source

sshs3 wouldn't exist without these projects:

| Project | Role |
| :--- | :--- |
| [Electron](https://www.electronjs.org/) | Cross-platform desktop app shell (Chromium + Node.js) |
| [React](https://react.dev/) | Renderer UI |
| [xterm.js](https://xtermjs.org/) (`xterm`, `@xterm/addon-fit`) | In-browser terminal emulator that renders the PTY output |
| [node-pty](https://github.com/microsoft/node-pty) | Spawns and drives the real `ssh`/shell process as a pseudo-terminal |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`) | S3-compatible object storage operations (AWS, MinIO, NetApp StorageGRID, etc.) |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-sso`, `@aws-sdk/client-sso-oidc`, `@aws-sdk/credential-provider-sso`) | AWS SSO (IAM Identity Center) device-authorization login, account/role listing, and temporary credentials |
| [win-ca](https://github.com/ukoloff/win-ca) | Reads the Windows certificate store so corporate/self-signed CAs are trusted |
| [Tailwind CSS](https://tailwindcss.com/) | Utility-first styling for the renderer UI |
| [lucide-react](https://lucide.dev/) | Icon set used throughout the UI |
| [TanStack Virtual](https://tanstack.com/virtual) | Virtualized rendering for large file listings |
| [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) | Lazy-loaded Markdown preview in the in-app file editor |
| [Vite](https://vitejs.dev/) + [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron) | Dev server and build tooling for renderer, main, and preload bundles |
| [TypeScript](https://www.typescriptlang.org/) | Strict typing shared across main/preload/renderer via `src/shared/types` |
| [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/) | Unit and component test suite |
| [ESLint](https://eslint.org/) + [typescript-eslint](https://typescript-eslint.io/) | Linting |
| [@kubernetes/client-node](https://github.com/kubernetes-client/javascript) | Kubernetes client for cluster discovery, WebSocket exec sessions, and log streams |
| [pkcs11js](https://github.com/PeculiarVentures/pkcs11js) | Native PKCS#11 bindings for reading smartcard certificates directly from hardware modules |
| [@xterm/addon-search](https://www.npmjs.com/package/@xterm/addon-search) | Real-time text search for terminal logs and output panes |
| [electron-builder](https://www.electron.build/) | Packaging (AppImage/deb/rpm for Linux, NSIS/portable/ZIP for Windows) and GitHub Releases publishing |

---

## Default keyboard shortcuts

| Action | Default key | Description |
| :--- | :--- | :--- |
| **New Terminal** | `Ctrl+Shift+T` | Opens a new terminal tab |
| **New File Manager** | `Ctrl+Shift+F` | Opens a new file manager tab |
| **Close Tab** | `Ctrl+W` | Closes the active tab |
| **Next Tab** | `Ctrl+Tab` | Cycles to the next tab |
| **Previous Tab** | `Ctrl+Shift+Tab` | Cycles to the previous tab |
| **Connection Manager** | `Ctrl+Shift+O` | Opens saved profiles and connections |
| **Settings** | `Ctrl+,` | Opens the settings panel |
| **Split Vertically** | `Ctrl+Shift+D` | Splits the active pane into two columns |
| **Split Horizontally** | `Ctrl+Shift+E` | Splits the active pane into two rows |
| **Next Split Pane** | `Ctrl+Shift+N` | Focuses the next split pane in the active tab |
| **Previous Split Pane** | `Ctrl+Shift+P` | Focuses the previous split pane in the active tab |
| **Navigate Left / Right / Up / Down** | `Ctrl+Shift+Arrows` | Moves focus spatially between split panes, tabs, file manager panes, menus and dialogs (Up from the top goes to the tab bar, Down goes back in) |
| **Clipboard History** | `Ctrl+Shift+R` | Opens the encrypted terminal selection history |
| **Search in Terminal** | `Ctrl+Shift+S` | Opens the search bar in the focused terminal |
| **Copy Last Command Output** | `Ctrl+Shift+G` | Copies the output of the previous command |
| **Snippets** | `Ctrl+Shift+L` | Opens the snippet palette in the focused terminal |
| **AI Assistant** | `Ctrl+Shift+A` | Suggests a command or explains output in the focused terminal (opt-in) |
| **AI: Turn Typed Text into a Command** | `Ctrl+Shift+Space` | Replaces the description typed at the prompt with a command, without running it (opt-in) |
| **Search in Files** | `Ctrl+Shift+K` | Opens file content search across local/SFTP/S3 panes |

*(All shortcuts are rebindable under Settings → Keyboard Shortcuts.)*

The app is built to be usable without a mouse: `Ctrl+Shift+Arrows` navigates, `Enter` activates (opens folders, connects, toggles checkboxes, runs the focused action) and `Escape` closes menus and dialogs and gives focus back to where you came from.

---

## System Requirements

While sshs3 bundles its core runtime (Chromium, Node.js, AWS SDK, and SFTP engine), certain features interact directly with your operating system's native tools:

### Core Requirements
- **OpenSSH Client (`ssh`, `ssh-agent`, `ssh-add`)**:
  - The terminal spawns your system's native `ssh` binary via a pseudo-terminal (PTY) to ensure full compatibility with `~/.ssh/config`, native keys, and proxy chains.
  - **Linux**:
    - Fedora / RHEL / Rocky: `sudo dnf install openssh-clients`
    - Debian / Ubuntu / Mint: `sudo apt install openssh-client`
    - Arch Linux: `sudo pacman -S openssh`
  - **Windows**: The built-in **OpenSSH Client** (included in Windows 10/11; enable via *Settings → Apps → Optional features → OpenSSH Client*).
- **Secure Keyring Storage (`safeStorage`)**:
  - Used to encrypt saved passwords, passphrases, and remote sync keys at rest on your local disk.
  - **Linux**: `libsecret` and a desktop keyring service (e.g. `gnome-keyring` or `kwallet`).
  - **Windows**: Built-in (Windows DPAPI / Credential Manager).

### For Hardware Security Keys (FIDO2 / YubiKey) & Smartcards (Optional)
If connecting with FIDO2 security keys, SITHS, YubiKey, PIV/CAC, or Net iD cards:
- **FIDO2 / WebAuthn Security Keys (`ed25519-sk` / `ecdsa-sk`)**:
  - OpenSSH 8.2+ with FIDO2/U2F support (standard on modern Linux distributions and Windows 10/11 OpenSSH).
  - *(Optional)* `ykman` (`yubikey-manager`) CLI for automated resident credential listing and hardware discovery (`sudo dnf install yubikey-manager` / `sudo apt install yubikey-manager` / `winget install Yubico.YubiKeyManager`).
- **PC/SC Smart Card Daemon & Reader Drivers (for PIV / PKCS#11)**:
  - **Linux**: Install `pcscd` and the CCID reader driver, then ensure the daemon is running:
    - *Fedora / RHEL*: `sudo dnf install pcsc-lite pcsc-lite-ccid && sudo systemctl enable --now pcscd`
    - *Debian / Ubuntu*: `sudo apt install pcscd pcsc-tools libccid && sudo systemctl enable --now pcscd`
  - **Windows**: The native *Smart Card* service (`SCardSvr`) is installed and enabled by default; standard CCID readers are plug-and-play.
- **PKCS#11 Library / Driver**:
  - **Linux**: `p11-kit` (providing `/usr/lib64/p11-kit-proxy.so` or `/usr/lib/x86_64-linux-gnu/p11-kit-proxy.so`, recommended as it proxies all registered system tokens), `opensc` (`opensc-pkcs11.so`), `libykcs11` (Yubico PIV tool / YubiKey Manager), or Net iD (`libiidp11.so`).
  - **Windows**: OpenSC (`opensc-pkcs11.dll`), YubiKey PIV (`libykcs11.dll`), or Net iD Client (`iidp11.dll`).
- **Windows only, for "Once Per Terminal Connection" / "Global" PIN caching**: the built-in **OpenSSH Authentication Agent** service, disabled by default. The Windows installer asks for administrator approval (UAC) near the end of setup to set it to start automatically and start it; if you decline, use the portable build, or run a silent install/auto-update (which skips the prompt), enable it once yourself, as Administrator: `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent`. Not needed for "Always Prompt" mode, which logs into the card directly per connection.

### Bundled Features (No Extra Software Required)
- **S3 & AWS SSO**: Object storage transfers, bucket operations, and AWS IAM Identity Center (SSO) browser-based logins run entirely on the bundled AWS SDK v3. No AWS CLI or Python installation required.
- **SFTP & File Manager**: Dual-pane file browsing and transfers use a built-in SFTP v3 protocol engine, carried over your system's OpenSSH client (`ssh`). OpenSSH must be installed — on Windows that's the built-in *OpenSSH Client* feature, the same one the terminal already needs.
- **TLS & CA Certificates**: System root CA certificates are automatically read from the OS trust store (Windows certificate store or Linux distribution CA bundles).

---

## Installation

Prebuilt binaries are available on [GitHub Releases](https://github.com/alun-hub/sshs3/releases):

### Linux
- **AppImage** — no installation required:
  ```bash
  chmod +x sshs3-*.AppImage
  ./sshs3-*.AppImage
  ```
- **DEB (Debian / Ubuntu / Linux Mint)**:
  ```bash
  sudo dpkg -i sshs3_*_amd64.deb
  ```
- **RPM (Fedora / RHEL / openSUSE)**:
  ```bash
  sudo rpm -Uvh sshs3-*.x86_64.rpm
  ```

### Windows
- **NSIS Installer**: `sshs3-Setup-<version>.exe` (installation wizard with a desktop shortcut, firewall configuration for bundled VcXsrv, and optional OpenSSH agent service startup). Stores user data in `%APPDATA%\sshs3`.
- **Portable standalone**: `sshs3-<version>-portable.exe` (single self-contained `.exe`, no installation). User data is automatically isolated in a `data/` folder next to the executable, keeping it completely portable on USB drives and avoiding collisions with any installed copy.
- **Portable ZIP**: `sshs3-<version>.zip` (pre-extracted folder archive). Extract to any directory or USB drive and run `sshs3.exe` immediately without any `%TEMP%` extraction delay. If a `data` folder exists next to `sshs3.exe`, it will be used for user data; otherwise it defaults to `%APPDATA%\sshs3`.
- **Single-instance window focusing**: If sshs3 is already running, launching the application again (installed or portable) safely brings the existing window to the front and focuses it instead of failing or conflicting over profile locks.

---

## Development

### Prerequisites
- Node.js 20+
- npm 10+
- A C/C++ build toolchain (for the native `node-pty` module via `node-gyp`)
- On Linux, `rpm` if you intend to package RPMs

### Getting started
```bash
# 1. Clone
git clone https://github.com/alun-hub/sshs3.git
cd sshs3

# 2. Install dependencies
npm install

# 3. Start the dev server with hot reload
npm run dev
```

### Tests & quality checks
```bash
# TypeScript type checking
npm run typecheck

# Lint
npm run lint

# Unit tests (Vitest)
npm run test
```

### Packaging
```bash
# Linux AppImage only
npm run package:appimage

# All Linux targets (AppImage, deb, rpm)
npm run package:linux

# Windows (requires a Windows build environment)
npm run package:win
```

To include the built-in Hermes agent, build its runtime first (needs `git` and [uv](https://docs.astral.sh/uv/); the release workflow does this). It pins the Hermes release by tag and commit and installs its Python dependencies from Hermes' lockfile by hash, into `build-resources/hermes/`, which the installers pick up. Without it the app builds and runs as before, with the Hermes option greyed out.
```bash
node scripts/hermes/build-runtime.mjs
```

### Release & Deployment
An automated deployment script handles patch version bumping, staging, committing, git tagging, and pushing to trigger the GitHub Actions release workflow:
```bash
# Bump patch version, commit all code, tag (e.g. v0.96.3), and push to GitHub
npm run deploy
# or with a custom commit message:
./deploy.sh "feat: describe your change"
```

---

## Windows vs. Linux: differences, limitations & workarounds

sshs3 is one codebase, but the Windows build can't do everything the Linux build does. Most gaps come from Microsoft's build of OpenSSH and from how Windows runs `ssh-agent`, not from sshs3 itself. Where the app can compensate, it does (and says so in the UI); where it can't, this section lists what's different so you aren't surprised.

**At a glance**

| Area | Linux | Windows |
|---|---|---|
| FIDO2 **resident** (discoverable) keys | Supported (`ssh-add -K`, `ykman`) | **Not available** — use a key file instead |
| FIDO2 key file (`id_ed25519_sk`) in the **terminal** | Supported | Supported (PIN + touch on every connection) |
| FIDO2 in the **SFTP file manager** | Supported (key file or resident key) | Supported with a key file (resident keys not available) |
| FIDO2 PIN caching / global agent / startup unlock | Supported | **Not applicable** |
| Listing / deleting resident credentials | Via `ykman` | Not available (`ykman` needs Administrator) |
| Smartcard (PKCS#11) PIN caching | Private `ssh-agent` per app/terminal | Shared Windows **ssh-agent service** (see below) |
| Needs an `ssh-agent` service set up first | No — the app spawns its own | **Yes** — "OpenSSH Authentication Agent" service |
| `libykcs11` (Yubico) through the agent | Works | Needs one extra setup step (system `PATH`) |
| `p11-kit` | Supported (recommended) | Not available |
| Certificate details in the cached-cards popover | Always | Depends on the build; OpenSC is needed for the fallback |

### FIDO2 / security keys

- **Resident (discoverable) credentials don't work on Windows.** They can only be read back from the device with `ssh-add -K`, `ssh-keygen -K` or `ykman`. On Windows, `ssh-add -K` fails (`Provider "internal" returned failure -1` / `device not found` — even when run as Administrator) and `ykman fido credentials list` refuses to run without Administrator rights. So on Windows the profile form disables the *resident* option, the key generator defaults to (and only offers) a key **file**, the automatic scan never runs, and the FIDO2 step of "Unlock at startup" is skipped so you aren't asked for a PIN just to get an error. If an existing Windows profile is still set to resident, the form tells you to switch it.
- **Use a key file instead.** In the profile, leave *resident* unticked and use **Generate a new key on this security key** (or pick an existing `id_ed25519_sk` / `id_ecdsa_sk`). Windows signs through its own WebAuthn support, which needs no Administrator rights. Add the new public key to the server's `authorized_keys`.
  - If generation fails with `A resident key scoped to 'ssh:…' already exists … Overwrite key in token (y/n)?`, the device already holds a resident credential with that name from an earlier attempt. Untick *resident* (recommended on Windows), or use a different output file name.
- **A touch is required on every connection.** A FIDO2 key created with *Require PIN + touch* needs a physical touch for every signature, so there is nothing to cache — the global agent, *Once per terminal* and *Always prompt* modes only affect smartcards (PKCS#11) on Windows. The Settings page says so.
- **SFTP works with FIDO2 profiles.** The file manager uses the same OpenSSH client as the terminal, so a security-key profile also works for file transfers: you'll get the usual PIN dialog and touch banner when connecting. (Earlier versions used an embedded JavaScript SSH library that couldn't use `-sk` keys, so the SFTP buttons were disabled for FIDO2 profiles — that limitation is gone.) Resident keys are Linux-only, as above; on Windows use a key file. The Windows SFTP + key-file path hasn't been verified on real hardware yet.
- **Be careful with repeated PIN attempts.** A FIDO2 key counts failed/rapid PIN verifications and temporarily blocks PIN entry until it's unplugged and reconnected. Unplug/replug it if you see that message (the wording of that hint was verified on Linux; on Windows a similar-looking `failure -1` is usually the resident-key limitation above).

### Smartcards / PKCS#11

- **A shared system agent instead of a private one.** On Linux every PIN-caching mode spawns its own private `ssh-agent`. Windows' `ssh-agent.exe` only runs as the single system service (pipe `\\.\pipe\openssh-ssh-agent`) and refuses a second instance, so all modes — including *Always prompt* — load the card into **that shared service**. Consequences:
  - Any other program that talks to the Windows OpenSSH agent can use the card while it's loaded (Global mode: until you quit the app or use **Lock All Now**).
  - The top-bar card popover lists *everything* in that agent, including keys you added yourself with `ssh-add` — not only what sshs3 loaded.
  - Restarting the service clears every key in it.
- **The "OpenSSH Authentication Agent" service must be running.** It's disabled by default on Windows, and the *OpenSSH Client* optional feature must be installed. The **installer** asks for administrator approval (UAC) near the end of setup and sets the service to *Automatic* and starts it. It does **not** do this for silent installs/auto-updates (to avoid a UAC prompt on every update), for the **portable** build, or if you decline the prompt — then run once, as Administrator:

  ```powershell
  Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent
  ```

  Without it you'll see *"Startup unlock failed … Windows OpenSSH Authentication Agent service is not running"*.
- **Pick the right PKCS#11 driver.** Windows detects Net iD, OpenSC and Yubico's `libykcs11`; there is no `p11-kit`. **OpenSC (`opensc-pkcs11.dll`) is listed first and is the most reliable choice**, including for a YubiKey's PIV applet. The *Smartcard* settings let you choose a **default driver** (used by startup unlock and when linking Remote Profile Sync); individual profiles keep their own.
- **`libykcs11.dll` (Yubico) needs its folder on the system `PATH`.** It depends on DLLs (`libcrypto-3-x64.dll`, `libykpiv.dll`, `zlib1.dll`) that sit next to it, and the agent service only searches the *machine* `PATH`. Without that, `ssh-add -s` fails with just `agent refused operation` — before any PIN reaches the card — so sshs3's "wrong PIN" retry message is misleading in that case (your PIN retry counter is untouched; check with `ykman piv info`). When you choose `libykcs11` as the default driver and this applies, Settings shows a **Fix Windows ssh-agent** button: it adds the driver's folder to the **system-wide** `PATH` and restarts the agent, after a UAC prompt. That change is visible to *every* program (the DLLs have generic names), which is why it's an explicit button and not something the installer does silently. Manual equivalent, as Administrator:

  ```powershell
  $p = 'C:\Program Files\Yubico\Yubico PIV Tool\bin'
  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $p, 'Machine')
  Restart-Service ssh-agent
  ```

- **Certificate details in the cached-cards popover** (subject, UPN, validity) are read through the optional native `pkcs11js` addon, which needs a compiler toolchain (Python + Visual C++ build tools) to build and may be missing in a given Windows build. When it isn't there, sshs3 falls back to OpenSC's `pkcs11-tool.exe` (shipped with OpenSC). Without either (for example a Net iD–only setup on a build without the addon) the identity shows its key type but "No certificate details found on the card".
- **SFTP with a smartcard is expected to work** (the agent exposes the PIV key as a normal RSA/ECDSA key), but like every PKCS#11 operation it needs the PIN once per the caching mode.
- **Two drivers for one card don't share a cache.** The global cache is keyed by library path, so the same physical card loaded through `opensc-pkcs11.dll` and through `libykcs11.dll` counts as two entries and asks for the PIN twice. Remote Profile Sync reuses an already-unlocked agent that holds the linked key, but profiles don't — keep profiles and the default driver on the same library.

### `~/.ssh/config` managed block & paths

- Remote Profile Sync can write a managed block into your real `~/.ssh/config`, generated from your profiles. Windows paths contain spaces (`C:\Program Files\…`), which OpenSSH splits into separate arguments (`line N: keyword pkcs11provider extra arguments at end of line` — breaking *every* `ssh` call, not just sshs3). sshs3 now quotes `PKCS11Provider` / `IdentityFile` / `CertificateFile` values containing spaces and uses forward slashes when it writes the block.
- The block is written as a whole ("newest wins"), and library/key paths are machine-specific, so a block generated on Windows isn't meaningful on a Linux machine (and vice versa). Treat the managed block as per-machine.

### Building & developing on Windows

- `node-pty` and `pkcs11js` are native modules. A full rebuild needs **Python** and the **Visual C++ build tools**; without them `electron-builder` stops at `Could not find any Python installation to use`. `node-pty` ships prebuilt Windows binaries, so packaging with `npx electron-builder --win --config.npmRebuild=false` works — but `pkcs11js` is then *not* built (see the certificate-details note above).
- Installing with `npm install --ignore-scripts` skips these builds too.
- One unit test (`LocalStorageProvider › delete › broken symlink`) fails on Windows unless symlinks are allowed (Developer Mode or an elevated shell): `EPERM: operation not permitted, symlink`. It is unrelated to app behaviour.

---

## Known Limitations

- **Performance bar on non-Linux hosts**: the SSH metrics are read from `/proc`, so a macOS/BSD server shows "Metrics need a Linux host". On Windows the app has no ControlMaster socket to reuse, so the bar is not available for SSH sessions there (local shell and Kubernetes work). Network, swap, disk I/O, iowait/steal, processes and cache are not available for a local shell on macOS/Windows.
- **Linux Drag & Drop Cursor Icon**: On some Linux desktop environments (notably GNOME/Wayland or KDE Plasma with certain cursor themes like Breeze), Chromium's native drag-and-drop implementation does not update the mouse cursor bitmap during internal pane-to-pane drags, displaying a "forbidden" or "no-drop" icon (white circle with red slash). This is an upstream Chromium window manager integration quirk; dragging and dropping files between panes and into folders works normally and completely reliably.

---

## Community & Contributing

Contributions are welcome! Please see our:
- [Contributing Guide](CONTRIBUTING.md) for local development setup, code standards, and PR process.
- [Code of Conduct](CODE_OF_CONDUCT.md) for community standards.
- [Security Policy](SECURITY.md) to report vulnerabilities responsibly.
- [Changelog](CHANGELOG.md) for release history and recent updates.

---

## License

This project is licensed under the [MIT License](LICENSE).
