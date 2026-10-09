## Terminal & Workspace Ergonomics

The terminal engine in **sshs3** pairs hardware-accelerated web rendering via **xterm.js** with your operating system's native OpenSSH client process via **`node-pty`**. Unlike clients relying on JavaScript SSH emulators, all native OpenSSH options, configuration files, smartcards, and command-line habits function identically to your standard terminal.

![Split Terminal Workspace](/img/split-terminal.png)

---

## 1. Native OpenSSH Engine via `node-pty`

### Feature: Real OpenSSH Binary Execution

#### 🎯 Purpose
Deliver 100% fidelity with the system OpenSSH stack (`~/.ssh/config`, `ProxyCommand`, `Match` directives, token agents, FIDO2, Kerberos/GSSAPI) without the regressions common to JavaScript reimplementations.

#### 🛠️ How to Use
- Launch any SSH profile or press <kbd>Ctrl+Shift+T</kbd> to open a new terminal session.
- Features ANSI/VT100/VT220 emulation, 24-bit TrueColor, and mouse tracking (in `htop`, `mc`, `tmux`, `nvim`).
- Adjust font size on the fly per tab using <kbd>Ctrl++</kbd>, <kbd>Ctrl+-</kbd>, and <kbd>Ctrl+0</kbd> (reset).

#### ⚠️ Limitations & Caveats
- Requires an OpenSSH client binary (`ssh`) accessible in system `$PATH`.
- On Windows, the optional OpenSSH Client feature must be active (enabled by default in Windows 10/11).

#### ⚙️ Technical Internals & Architecture
`SSHPtyManager` (`src/main/ssh/SSHPtyManager.ts`) allocates a pseudo-terminal (PTY) via native C++ bindings provided by `node-pty`. It invokes `ssh <arguments> <host>` in an isolated session. Data streams pass through Electron IPC (`IPC_CHANNELS.TERMINAL_DATA`, `IPC_CHANNELS.TERMINAL_WRITE`, `IPC_CHANNELS.TERMINAL_RESIZE`).

---

## 2. Konsole-Style Recursive Split Panes

sshs3 implements non-destructive recursive pane splitting modeled on KDE's **Konsole** (`ViewSplitter`):

![Recursive Split Panes](/img/split.png)

### Feature: Non-Destructive Split Layouts

#### 🎯 Purpose
Allow operators to split workspace real estate horizontally and vertically without disrupting existing sessions, interrupting running background commands, or losing scrollback buffers.

#### 🛠️ How to Use
1. **Split Vertically**: Press <kbd>Ctrl+Shift+D</kbd> or click the vertical split icon on the pane's mini-toolbar.
2. **Split Horizontally**: Press <kbd>Ctrl+Shift+E</kbd> or click the horizontal split icon.
3. **Keyboard Navigation Between Panes**:
   - **Directional Spatial Navigation (<kbd>Ctrl+Shift+Arrow Keys</kbd>)**: Shifts focus in the direction of the arrow. Pressing <kbd>Ctrl+Shift+Up</kbd> from the top row moves focus directly into the **Tab Bar** (where <kbd>Left</kbd>/<kbd>Right</kbd> switches active tabs, and <kbd>Down</kbd> or <kbd>Enter</kbd> returns focus into the active terminal pane).
   - **Sequential Cycling**: Use <kbd>Ctrl+Shift+N</kbd> (next pane in tree) and <kbd>Ctrl+Shift+P</kbd> (previous pane).
4. **Close a Pane**: Click the close button on its mini-toolbar or type `exit`. The tree automatically collapses to fill the remaining area.
5. **Unsplit (Maximize)**: Click the "Unsplit" icon on the active pane to keep the focused session and close all siblings.

#### ⚠️ Limitations & Caveats
- Splitting a terminal too many times on smaller displays can reduce column width below 40 characters, causing line wrapping in wide tabular tools.
- Each pane runs an independent SSH or shell process with its own memory allocation.

#### ⚙️ Technical Internals & Architecture
Splitting a pane does not recreate or restart the underlying PTY session. The active DOM node is reparented into a new split container within React's layout tree (`SplitTree.tsx`), leaving the underlying Node.js PTY process completely uninterrupted.

---

## 3. Local Shells & Intelligent SSH Agent Management

In addition to remote SSH hosts, sshs3 allows opening local terminal tabs executing directly on your workstation (`bash`, `zsh`, `fish`, `pwsh`, WSL).

### Feature: Managed `SSH_AUTH_SOCK` Injection & `AgentLifecycleManager`

#### 🎯 Purpose
Provide integrated access to local workstation shells with immediate single sign-on access to smartcards, YubiKeys, and SSH keys already unlocked within sshs3.

#### 🛠️ How to Use
Configure the **Local Terminal SSH Agent** behavior under *Settings → Terminal*:
- **Auto (Default)**: If Global PIN caching is active, local shells automatically inherit the app-wide `AppAgent` socket. Unlocked smartcards and FIDO2 keys are instantly available for local `git`, `ssh`, and `terraform` commands! If Global caching is not active, it uses the system/login-shell agent, or starts an app-managed private agent.
- **System Only**: Strictly inherits your existing desktop `$SSH_AUTH_SOCK` (e.g. gpg-agent or systemd-user ssh-agent) and never starts an app agent.
- **Disabled**: Wipes `SSH_AUTH_SOCK` and `SSH_AGENT_PID` completely from the spawned shell environment.

#### ⚙️ Technical Internals & Architecture
`AgentLifecycleManager` probes for a running agent (or Windows OpenSSH Agent service). In `auto` mode under Global PIN caching, the app-wide agent (`AppAgent`) always takes precedence on a stable socket (`$XDG_RUNTIME_DIR/sshs3/agent.sock` or `/tmp/sshs3-agent-<uid>/agent.sock`). Because the socket path is stable, local terminal tabs opened *before* unlocking a smartcard can immediately use the card once unlocked without reopening the tab!

#### 🛠️ How to Use
- Click the "+" icon in the tab bar and select **Local Shell**.
- Under *Settings → Local Terminal SSH Agent*, configure socket injection behavior:
  - **Auto (Default)**: Priority resolution order: (1) App-wide smartcard agent (`AppAgent`) under Global PIN caching, (2) App's managed agent process, (3) System inherited agent (`$SSH_AUTH_SOCK`), (4) Newly spawned managed agent.
  - **System Only**: Strictly uses the inherited environment socket; never spawns or overrides with app agents.
  - **Disabled**: Injects no `SSH_AUTH_SOCK` variable.

#### ⚠️ Limitations & Caveats
- `SSH_AUTH_SOCK` is resolved and injected at the moment the local process is spawned. A shell tab opened *before* a smartcard is unlocked will not inherit the card unless Global PIN caching was already active.

#### ⚙️ Technical Internals & Architecture
Managed by `AgentLifecycleManager` (`src/main/ssh/AgentLifecycleManager.ts`). Under Global PIN caching mode, the socket points to `AppAgent`, a dedicated local socket proxy that multiplexes SSH signing requests directly through unlocked hardware cards.

---

## 4. Terminal Productivity & Ergonomics

![Terminal Settings](/img/docs/settings-terminal.png)
![Terminal Settings Details](/img/docs/settings-terminal2.png)

### 4.1 Scrollback Buffer Search (<kbd>Ctrl+Shift+S</kbd>)
- Opens an overlay search bar with match count indicator (e.g. `3/6`). Matches update dynamically as you type.
- Step through occurrences forward with <kbd>Enter</kbd> and backward with <kbd>Shift+Enter</kbd>. Close the bar with <kbd>Esc</kbd>.
- Highlight colors adapt to the active theme (Breeze, Light, Dark). The active match is highlighted distinctly.
- Stepping through matches highlights text without triggering Copy-on-Select.

### 4.2 Clickable URLs and File Paths (<kbd>Ctrl+Click</kbd>)
Hold <kbd>Ctrl</kbd> (<kbd>Cmd</kbd> on macOS) and click:
- **Web URLs**: Any `http://` or `https://` link opens in your workstation's default browser (supported in terminals and Kubernetes log streams).
- **Remote File Paths**: Clicking a file or directory path in an SSH terminal (e.g. `/var/log/syslog`, `~/notes.md`, `/srv/app.py:42:7`) **immediately opens that folder in a new SFTP file manager tab**!
  - Because terminal emulators cannot distinguish directories from files without filesystem access, clicking a file path without a trailing slash opens its containing parent directory.
  - Tilde paths (`~/`) resolve automatically to `/home/<user>` (or `/root`).
  - The SFTP tab always connects using the pane's underlying profile credentials, even if you hopped to another host using `ssh` inside the terminal.
  - Note: Paths are not clickable in local shell or Kubernetes exec terminals.

### 4.3 Saved Command Snippets Palette (<kbd>Ctrl+Shift+L</kbd>)
- Searchable palette of pre-saved shell commands and runbooks.
- <kbd>Enter</kbd> types the command into the prompt; <kbd>Ctrl+Enter</kbd> types and executes it immediately. Multi-line snippets are pasted as an atomic batch.
- Manage snippets with **New**, pencil (edit), and bin (delete). Snippets can be scoped to the current profile or made globally accessible.
- Dynamic variables: `{{host}}`, `{{user}}`, and `{{date}}` (formatted as `yyyy-mm-dd HH:mm`).
- *Security Note:* Snippets are saved unencrypted in `snippets.json`. Do not store passwords or API secrets in snippets!

### 4.4 Copy Last Command Output (<kbd>Ctrl+Shift+G</kbd>)
- Copies the terminal output of the immediately preceding command without manual mouse selection.
- A toast notification confirms how many lines were copied to clipboard.
- **Exact**: In modern shells emitting **OSC 133 semantic prompt marks** (`fish`, and `zsh`/`bash` with shell integration).
- **Heuristic Fallback**: In standard shells, infers command boundaries from Enter keypresses. Full-screen terminal programs (`vim`, `less`, `htop`) are ignored.

### 4.5 Encrypted Clipboard History (<kbd>Ctrl+Shift+R</kbd>)
- When *Copy text automatically on selection* is enabled, every highlighted string is stored in an encrypted history ring.
- Press <kbd>Ctrl+Shift+R</kbd> or right-click to search and paste previous selections (<kbd>↑</kbd>/<kbd>↓</kbd> navigate, <kbd>Enter</kbd> pastes).
- <kbd>Shift+Insert</kbd> and middle-click paste the latest entry.
- Encrypted at rest via the OS keyring (`safeStorage`). If the OS keyring is unavailable, history is retained in volatile memory only. Can be scoped per connection or configured to purge on application exit.

### 4.6 AI Assistant (<kbd>Ctrl+Shift+A</kbd>, <kbd>Ctrl+Shift+Space</kbd>, opt-in)
- Off by default. Turn it on with **Enable the AI assistant in terminals** under **Settings → AI Assistant**, choose a **Provider** (**Anthropic (Claude)** or **OpenAI-compatible (Ollama, LM Studio, …)**), a **Model**, and an **API key** and/or **Endpoint**, then click **Save AI settings**.
- **Suggest a command**: describe the task and press <kbd>Enter</kbd> (<kbd>Shift+Enter</kbd> for a new line). The answer is one command plus a short explanation; commands that change or delete data start with "Warning:". **Insert into terminal** types it at the prompt without pressing Enter, so you always review it and run it yourself. **Copy** puts it on the clipboard.
- **Explain output**: opens by default when text is selected. Ask about the selection or the last command output, with or without a question.
- **Include from terminal** chooses what terminal text is sent (**Nothing**, **Selected text** or **Last command output**); **Show what will be sent** previews it. Nothing leaves the app until you click **Ask**.
- **✨ Explain this error**: after a command fails, this button appears at the bottom left of the terminal. Clicking it opens the assistant on **Explain output** and asks about the last command output straight away; **Show what will be sent** shows what was included. The button disappears with the next command, and **×** dismisses it. Failures are detected from the exit code in shells that send OSC 133 prompt marks (fish, and zsh/bash with shell integration); exit codes 130 and 148 (stopped with <kbd>Ctrl+C</kbd> or <kbd>Ctrl+Z</kbd>) don't count. Other shells are checked for typical error messages at the end of the output, such as `command not found`, `No such file or directory`, `Permission denied` or a Python traceback, so some failures go unnoticed there. The button only appears while the assistant is turned on.
- **AI: Turn Typed Text into a Command (<kbd>Ctrl+Shift+Space</kbd>)**: type a description at the prompt instead of a command, for example `largest folders here, sorted`, and press the shortcut. The typed text (and nothing else from the terminal) is sent, and when the answer is a single command it replaces the text in place, ready to review and run with <kbd>Enter</kbd>. The explanation, or a "Warning:" for commands that change or delete data, shows at the bottom of the terminal. If nothing is typed, or the line was changed in ways the app can't follow (history recall, tab completion, arrow keys), the assistant dialog opens instead; type the description there.
- *Security Note:* passwords, tokens, AWS access keys, `Bearer` headers, `user:password@` URLs and private key blocks are masked before sending, using the same rules as the log file. Masking is pattern based, so check the preview for anything else sensitive. Use an OpenAI-compatible local model (for example Ollama at `http://localhost:11434/v1`) to keep terminal text on your machine. The API key is encrypted with the OS keyring, and AI settings are stored in `ai-config.json`, which is not part of remote profile sync.

### 4.7 Terminal Settings Reference Table

| Setting | Default | Purpose & Description |
| :--- | :--- | :--- |
| **Terminal Font Size** | `13` | Base font size. Adjust dynamically with <kbd>Ctrl++</kbd>, <kbd>Ctrl+-</kbd>, <kbd>Ctrl+0</kbd>. |
| **Terminal Font Family** | Monospace stack | Select from curated monospaced fonts or enter a custom font name. |
| **Cursor Style** | `Block` | Visual cursor appearance: `Block`, `Underline`, or `Bar`. |
| **Scrollback Buffer (lines)** | `5000` | Retained terminal history per pane, searchable with <kbd>Ctrl+Shift+S</kbd>. |
| **Copy text automatically on selection** | `Off` | Copies highlighted text to the clipboard and records it in encrypted clipboard history. |
| **Clipboard history scope** | `Global` | Share clipboard history across all sessions or isolate history per host. |
| **Empty clipboard history on exit** | `Off` | Automatically wipes the encrypted clipboard history when sshs3 shuts down. |
| **On Logout / Session End** | `Reconnect` | Action when an SSH session disconnects: **Reconnect**, **Close Tab**, or **Keep Open**. |
| **Local Terminal SSH Agent** | `Auto` | How `SSH_AUTH_SOCK` is populated in local shell tabs: **Auto** (uses unlocked app-wide agent `AppAgent` under Global PIN caching, otherwise system's/login-shell's agent, otherwise an app-spawned agent), **System Only** (only uses pre-existing system agent), or **Disabled** (deletes `SSH_AUTH_SOCK`). |

---

## 5. Troubleshooting & Diagnostics Runbook

| Symptom / Error Message | Probable Root Cause | Corrective Action |
| :--- | :--- | :--- |
| Terminal displays blank black screen | System exhausted available PTY descriptors | Check PTY availability via `cat /proc/sys/kernel/pty/nr`. Close unneeded sessions. |
| Swedish / non-ASCII characters display garbled | Mismatched locale or encoding on remote host | Run `echo $LANG` on the server. Ensure a UTF-8 locale is exported (e.g., `export LANG=en_US.UTF-8`). |
| <kbd>Ctrl+Click</kbd> on path does nothing | Path is relative or lacks a leading `/` or `~/` | Clickable filesystem paths must be absolute (`/etc/...`) or home-relative (`~/...`). |
| Clipboard history is empty | "Copy text automatically on selection" is disabled | Open *Settings → Terminal* and check **Copy text automatically on selection**. |
