import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ShellKind,
  TerminalCommandFailure,
  TerminalSession,
} from "../../../shared/types/aiHub";
import {
  CommandFrames,
  commandEnvelope,
  lastVisibleLine,
  type CommandResult,
} from "./shellAdapters";
import { boundedContext } from "./privacy";

/**
 * Whether what the terminal last showed looks like a shell waiting for a
 * command: a line ending in $, #, %, > or ❯, and not the prompt of a database
 * client, a REPL or a pager. Nothing shown yet counts as a prompt: a terminal
 * that was just opened.
 */
export function atShellPrompt(tail: string | undefined): boolean {
  if (!tail) return true;
  // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
  const text = tail.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]/g, "");
  const last = text.split(/\r?\n|\r/).filter((l) => l.trim()).at(-1) ?? "";
  if (atSecretPrompt(last)) return false;
  if (/^(mysql|mariadb|sqlite|redis|irb|pry|mongo|cqlsh|ftp|sftp|telnet|\(gdb\)|>>>|\.\.\.|In \[\d+\])/i.test(last.trim())) return false;
  if (/^[\w-]+=[#>]\s*$/.test(last.trim())) return false; // psql: postgres=#
  if (/(--More--|\(END\)|^:)\s*$/.test(last)) return false;
  return /[$#%>❯»]\s*$/.test(last) || /^PS [A-Za-z]:\\.*>\s*$/.test(last.trim());
}

/** Whether the terminal is asking for a password, passphrase or token (and so not echoing what is typed). */
export function atSecretPrompt(tail: string): boolean {
  // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
  const last = tail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n|\r/).filter((l) => l.trim()).at(-1) ?? "";
  return /(?:password|passphrase|passcode|pin|token|secret|otp|verification code)[^:]{0,60}:\s*$/i.test(last) || /^\[sudo\]/i.test(last.trim());
}

interface LiveTerminal {
  view: TerminalSession;
  write: (data: string) => void;
  output: string;
  inputBuffer: string;
  /** The size the person's terminal has, as last reported. */
  cols?: number;
  rows?: number;
  /** The last bit the terminal showed, kept always: to tell a password prompt from a shell prompt. */
  tail?: string;
  /** When the terminal last showed anything. */
  fedAt?: number;
  /** When connecting automatically last failed, and why: it is not tried again for a while. */
  armFailedAt?: number;
  armFailure?: string;
  lastSubmittedCommand?: string;
  lastSubmittedAt?: number;
  trimPostHandshakeNewline?: boolean;
  /** The last line of the shell's prompt, as the latest handshake saw it (only where output can arrive late). */
  promptLine?: string;
  pending?: {
    frames: CommandFrames;
    handshake: boolean;
    resolve: (value: CommandResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    /** Runs while the frame has ended and text the terminal delivers late is waited for. */
    lateTimer?: NodeJS.Timeout;
    lateSince?: number;
  };
}

/** How long a terminal that delivers text late is given after the last text, and at most, before a command's frame is closed. */
const LATE_QUIET_MS = 150;
const LATE_MAX_MS = 800;

export interface DetectedCommandActivity {
  kind: "command" | "config-edit" | "service" | "deploy";
  summary: string;
  exitCode?: number;
  resolvedFailure?: TerminalCommandFailure;
}

/**
 * Classifies a human or AI shell command line if it represents a meaningful
 * infrastructure, configuration, package, container, or service change that
 * teammates and the workspace AI should know about.
 */
export function classifyNotableCommand(
  rawLine: string,
): DetectedCommandActivity | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.length > 2000) return null;
  // Strip leading sudo / env vars for pattern matching
  let normalized = line;
  while (/^(?:sudo|env)\s+/i.test(normalized)) {
    if (/^sudo\s+/i.test(normalized)) {
      normalized = normalized.replace(/^sudo\s+/i, "");
      while (/^-[A-Za-z]+\s+/.test(normalized)) {
        normalized = normalized.replace(/^-[A-Za-z]+\s+/, "");
      }
    } else {
      normalized = normalized.replace(/^env\s+/i, "");
      while (/^\S+=\S+\s+/.test(normalized)) {
        normalized = normalized.replace(/^\S+=\S+\s+/, "");
      }
    }
  }
  normalized = normalized.trim();

  // Config / file edits
  const editorMatch =
    /^(?:vim?|nvim|nano|emacs|micro|code|subl|sed\s+-i|tee\s+-a|tee)\s+(.+)$/i.exec(
      normalized,
    );
  if (editorMatch) {
    return {
      kind: "config-edit",
      summary: `Edited file/config: ${editorMatch[1].trim().slice(0, 140)}`,
    };
  }
  if (
    /(?:>|>>)\s*(\/etc\/\S+|~\/\.\S+|\S+\.(?:conf|yaml|yml|json|ini|env|toml|service|rules))/i.test(
      normalized,
    )
  ) {
    const target = RegExp.$1;
    return {
      kind: "config-edit",
      summary: `Updated config file ${target}`,
    };
  }

  // Systemd / service / firewall / network changes
  if (
    /^(?:systemctl|service)\s+(restart|reload|start|stop|enable|disable|mask|daemon-reload)\b/i.test(
      normalized,
    )
  ) {
    return {
      kind: "service",
      summary: `Service operation: ${normalized.slice(0, 160)}`,
    };
  }
  if (/^(?:ufw|iptables|nft|firewall-cmd|ip\s+route|ip\s+link|sysctl\s+-w|hostnamectl)\b/i.test(normalized)) {
    return {
      kind: "config-edit",
      summary: `System/network setting changed: ${normalized.slice(0, 160)}`,
    };
  }

  // Package & container & Kubernetes deployments
  if (
    /^(?:apt(?:-get)?|dnf|yum|apk|pacman|zypper|brew|pip3?|npm|pnpm|cargo)\s+(?:install|remove|purge|upgrade|update|uninstall)\b/i.test(
      normalized,
    )
  ) {
    return {
      kind: "deploy",
      summary: `Package change: ${normalized.slice(0, 160)}`,
    };
  }
  if (
    /^(?:docker\s+compose|docker|docker-compose|podman|nerdctl)\s+(?:up|down|restart|stop|start|rm|pull|build|run|exec)\b/i.test(
      normalized,
    )
  ) {
    return {
      kind: "deploy",
      summary: `Container action: ${normalized.slice(0, 160)}`,
    };
  }
  if (
    /^(?:kubectl|helm|terraform|ansible-playbook)\s+(?:apply|delete|scale|rollout|set|patch|edit|upgrade|install|uninstall|rollback)\b/i.test(
      normalized,
    )
  ) {
    return {
      kind: "deploy",
      summary: `Cluster/Infra deployment: ${normalized.slice(0, 160)}`,
    };
  }
  if (/^git\s+(?:pull|checkout|switch|merge|rebase|reset|cherry-pick)\b/i.test(normalized)) {
    return {
      kind: "deploy",
      summary: `Git state update: ${normalized.slice(0, 160)}`,
    };
  }
  if (/^(?:chmod|chown|usermod|useradd|passwd|crontab)\b/i.test(normalized)) {
    return {
      kind: "config-edit",
      summary: `Permissions/user/cron change: ${normalized.slice(0, 160)}`,
    };
  }
  if (/^sudo\s+/i.test(line)) {
    return {
      kind: "command",
      summary: `Privileged command: ${line.slice(0, 160)}`,
    };
  }
  return null;
}

/** Authoritative ownership lives beside the PTYs, never in React or in an LLM prompt. */
export class TerminalRegistry extends EventEmitter {
  private sessions = new Map<string, LiveTerminal>();
  /** The nonces of the commands this registry wrote, with the command: a late frame is known by them. */
  private issued = new Map<string, string>();
  private lastFailures = new Map<string, TerminalCommandFailure>();
  private lastResolvedFailures = new Map<string, TerminalCommandFailure>();
  private observing = false;

  /**
   * `lateOutput`: the terminals of this registry run in a pseudo console that
   * may deliver a command's output after its end marker (Windows). The frame
   * of a command is then closed when the prompt is back, not at the marker.
   */
  constructor(private readonly options: { lateOutput?: boolean } = {}) {
    super();
  }

  observe(enabled: boolean): void {
    this.observing = enabled;
    if (!enabled)
      for (const session of this.sessions.values()) session.output = "";
  }

  failures(): Record<string, TerminalCommandFailure> {
    return Object.fromEntries(this.lastFailures.entries());
  }

  consumeResolvedFailure(sessionId: string): TerminalCommandFailure | undefined {
    const resolved =
      this.lastResolvedFailures.get(sessionId) ??
      this.lastFailures.get(sessionId);
    this.lastResolvedFailures.delete(sessionId);
    if (this.lastFailures.delete(sessionId)) {
      this.emit("changed");
    }
    return resolved;
  }

  dismissFailure(sessionId: string): void {
    this.lastResolvedFailures.delete(sessionId);
    if (this.lastFailures.delete(sessionId)) {
      this.emit("changed");
    }
  }

  recordFailure(failure: TerminalCommandFailure): void {
    this.lastResolvedFailures.delete(failure.sessionId);
    this.lastFailures.set(failure.sessionId, failure);
    this.emit("changed");
  }

  register(
    input: Pick<
      TerminalSession,
      "id" | "label" | "kind" | "profileId" | "shell"
    >,
    write: (data: string) => void,
  ): void {
    if (this.sessions.has(input.id))
      this.invalidate(input.id, "Session replaced");
    this.sessions.set(input.id, {
      view: {
        ...input,
        generation: crypto.randomUUID(),
        state: "unknown",
        updatedAt: Date.now(),
      },
      write,
      output: "",
      inputBuffer: "",
    });
    this.emit("changed");
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values(), (s) => ({ ...s.view }));
  }
  get(id: string): TerminalSession | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s.view } : undefined;
  }
  context(id: string): string {
    return boundedContext(this.sessions.get(id)?.output ?? "");
  }

  /**
   * What a terminal sent, with sshs3's own markers taken out. Listeners get
   * the same text a person sees ("output"), with the terminal's owner at that
   * moment — which is what a recording of an agent's run is made from.
   */
  feed(id: string, data: string): string {
    const shown = this.feedInner(id, data);
    const owner = this.sessions.get(id)?.view.owner;
    if (shown && owner && this.listenerCount("output")) this.emit("output", id, shown, owner);
    return shown;
  }

  private feedInner(id: string, data: string): string {
    const s = this.sessions.get(id);
    if (!s) return data;
    if (s.pending) {
      try {
        const result = s.pending.frames.feed(data);
        const display = s.pending.frames.drainDisplay();
        if (this.observing && display && !s.pending.handshake) {
          s.output = (s.output + display).slice(-128_000);
        }
        if (result) this.finish(id, s, result);
        else if (s.pending.frames.awaitingLate) this.awaitLate(id, s);
        return display;
      } catch (error) {
        this.invalidate(
          id,
          error instanceof Error ? error.message : "Invalid terminal stream",
        );
        return "";
      }
    }
    let clean = data;
    if (s.trimPostHandshakeNewline) {
      s.trimPostHandshakeNewline = false;
      clean = clean.replace(/^[\r\n]+/, "");
    }
    if (this.observing && clean) {
      s.output = (s.output + clean).slice(-128_000);
    }
    if (clean) {
      s.tail = ((s.tail ?? "") + clean).slice(-240);
      s.fedAt = Date.now();
    }
    this.detectHumanOutputFailure(id, s, clean);
    return clean;
  }

  /** A command's frame is complete: the terminal is ready again and whoever ran it gets the result. */
  private finish(id: string, s: LiveTerminal, result: CommandResult): void {
    const pending = s.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.lateTimer);
    // After a handshake, which prints nothing, what the terminal shows last is the prompt.
    if (pending.handshake && pending.frames.awaitingLate) s.promptLine = pending.frames.promptSeen() || undefined;
    s.pending = undefined;
    s.trimPostHandshakeNewline = pending.handshake;
    s.view.state = "ready";
    s.view.cwd = result.cwd;
    s.view.updatedAt = Date.now();
    if (!pending.handshake && result.exitCode !== 0) {
      this.lastResolvedFailures.delete(id);
      this.lastFailures.set(id, {
        sessionId: id,
        label: s.view.label,
        command: pending.frames.commandText || s.lastSubmittedCommand || "",
        exitCode: result.exitCode,
        snippet: boundedContext(result.output, 1500),
        at: Date.now(),
      });
    } else if (!pending.handshake && result.exitCode === 0) {
      const prevFailure = this.lastFailures.get(id);
      if (prevFailure) {
        this.lastResolvedFailures.set(id, prevFailure);
        this.lastFailures.delete(id);
      } else {
        this.lastResolvedFailures.delete(id);
      }
    }
    pending.resolve({ ...result, output: boundedContext(result.output) });
    if (!pending.handshake) this.emit("executed", id, result.exitCode);
    this.emit("changed");
  }

  /**
   * The end marker came, and the terminal may still owe text printed before
   * it. The frame is closed when nothing has come for a moment (or the prompt
   * is back, which `feed` sees by itself), and never later than `LATE_MAX_MS`.
   */
  private awaitLate(id: string, s: LiveTerminal): void {
    const pending = s.pending;
    if (!pending) return;
    pending.lateSince ??= Date.now();
    clearTimeout(pending.lateTimer);
    const left = Math.max(0, pending.lateSince + LATE_MAX_MS - Date.now());
    pending.lateTimer = setTimeout(() => {
      if (s.pending !== pending) return;
      try {
        this.finish(id, s, pending.frames.settle());
      } catch (error) {
        this.invalidate(id, error instanceof Error ? error.message : "Invalid terminal stream");
      }
    }, Math.min(LATE_QUIET_MS, left));
  }

  private detectHumanOutputFailure(
    id: string,
    s: LiveTerminal,
    chunk: string,
  ): void {
    if (!chunk) return;
    // 0. Check passive OSC 777;SSHS3;<nonce>;BEGIN ... END;<exitCode>;<cwd> frame
    const sshs3Match =
      // eslint-disable-next-line no-control-regex
      /\x1b\]777;SSHS3;([a-f0-9]{32});BEGIN\x07([\s\S]*?)\x1b\]777;SSHS3;([a-f0-9]{32});END;([0-9]+);([^\x07]*)\x07/i.exec(
        chunk,
      );
    if (sshs3Match) {
      // Only a frame this app wrote, for a command it ran (one that ended after its run let go of it).
      // Anything else that looks like one is a program's output, and invents nothing.
      const issued = this.issued.get(sshs3Match[1]);
      if (!issued || sshs3Match[1] !== sshs3Match[3]) return;
      this.issued.delete(sshs3Match[1]);
      const body = sshs3Match[2] ?? "";
      const code = Number(sshs3Match[4]);
      const inferredCmd = issued;
      const outSnippet = body;
      if (code !== 0) {
        this.lastResolvedFailures.delete(id);
        this.lastFailures.set(id, {
          sessionId: id,
          label: s.view.label,
          command: inferredCmd,
          exitCode: code,
          snippet: boundedContext(outSnippet, 1500),
          at: Date.now(),
        });
        this.emit("changed");
      } else {
        const priorFailure = this.lastFailures.get(id);
        const classified =
          classifyNotableCommand(inferredCmd) ??
          (priorFailure && inferredCmd
            ? {
                kind: "command" as const,
                summary: `Resolved terminal failure with: ${inferredCmd}`,
              }
            : null);
        if (this.lastFailures.delete(id)) {
          this.emit("changed");
        }
        if (classified && inferredCmd) {
          this.emit("commandLine", { ...s.view }, inferredCmd, {
            ...classified,
            exitCode: 0,
            resolvedFailure: priorFailure,
          });
        }
      }
      return;
    }
    // 1. Check OSC 133;D;<exitCode> shell integration marker
    // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
    const oscMatch = /\x1b\]133;D;([0-9]+)(?:\x07|\x1b\\)/.exec(chunk);
    if (oscMatch) {
      const code = Number(oscMatch[1]);
      if (code !== 0) {
        this.lastResolvedFailures.delete(id);
        this.lastFailures.set(id, {
          sessionId: id,
          label: s.view.label,
          command: s.lastSubmittedCommand || "",
          exitCode: code,
          snippet: boundedContext(s.output.slice(-16_000), 1500),
          at: Date.now(),
        });
        this.emit("changed");
      } else {
        const priorFailure = this.lastFailures.get(id);
        const inferredCmd = (s.lastSubmittedCommand || "").trim();
        if (this.lastFailures.delete(id)) {
          this.emit("changed");
        }
        if (priorFailure && inferredCmd) {
          const classified = classifyNotableCommand(inferredCmd) ?? {
            kind: "command" as const,
            summary: `Resolved terminal failure with: ${inferredCmd}`,
          };
          this.emit("commandLine", { ...s.view }, inferredCmd, {
            ...classified,
            exitCode: 0,
            resolvedFailure: priorFailure,
          });
        }
      }
      return;
    }
    // 2. Check common terminal / storage / K8s / SSH error patterns within 15s of a human command
    if (
      s.lastSubmittedAt &&
      Date.now() - s.lastSubmittedAt < 15_000 &&
      /(?:command not found|Permission denied|No such file or directory|Connection refused|MountVolume\.SetUp failed|AttachVolume\.Attach failed|snapmirror.*broken-off|HEALTH_ERR|Error:\s+\S+|fatal:\s+\S+|502 Bad Gateway|503 Service Unavailable)/i.test(
        chunk,
      )
    ) {
      this.lastFailures.set(id, {
        sessionId: id,
        label: s.view.label,
        command: s.lastSubmittedCommand || "",
        exitCode: 1,
        snippet: boundedContext((s.output || chunk).slice(-1500), 1500),
        at: Date.now(),
      });
      this.emit("changed");
    }
  }

    /**
   * Collaborative human input observer used by the live terminal IPC bridge.
   * Never throws or revokes terminal readiness between AI turns, while still
   * allowing Ctrl+C takeover during an active framed AI command and detecting
   * notable config/service/infra commands for the shared workspace activity log.
   */
  observeHumanInput(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || !data) return;
    // A person typing into a terminal an agent holds takes it back: the agent's run lets go at
    // once, and what they typed goes through as typed (their own Ctrl-C included, and no second one).
    if (s.pending || s.view.owner) this.takeover(id, { interrupt: false });
    // Strip ANSI escape sequences (arrow keys, function keys, bracketed paste markers)
    // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
    const cleaned = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    for (const ch of cleaned) {
      if (ch === "\x7f" || ch === "\x08") {
        s.inputBuffer = s.inputBuffer.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        s.inputBuffer = "";
      } else if (ch === "\r" || ch === "\n") {
        const submitted = s.inputBuffer.trim();
        s.inputBuffer = "";
        // What the person ran may have changed the shell (another program, another user, another host):
        // the agent connects again at a prompt before it runs anything here.
        if (s.view.state === "ready") {
          s.view.state = "unknown";
          s.view.generation = crypto.randomUUID();
          this.emit("changed");
        }
        // An answer to a password prompt is not a command: it is never kept, so it can
        // never be named as the command that failed, nor learned from.
        if (submitted && atSecretPrompt(s.tail ?? "")) {
          s.lastSubmittedCommand = undefined;
          s.lastSubmittedAt = undefined;
        } else if (submitted) {
          s.lastSubmittedCommand = submitted;
          s.lastSubmittedAt = Date.now();
          const classified = classifyNotableCommand(submitted);
          if (classified) {
            this.emit("commandLine", { ...s.view }, submitted, classified);
          }
        }
      } else if (ch >= " ") {
        s.inputBuffer = (s.inputBuffer + ch).slice(-2048);
      }
    }
  }

  /**
   * Ensures a terminal has a known shell and is in the "ready" state without
   * forcing the user to manually click "Connect at prompt".
   */
  async ensureReady(
    id: string,
    fallbackShell?: ShellKind,
  ): Promise<TerminalSession> {
    const s = this.require(id);
    if (s.view.state === "ready" && s.view.shell) {
      return { ...s.view };
    }
    if (s.pending) throw new Error("Terminal is currently busy");
    if (s.armFailedAt && Date.now() - s.armFailedAt < 5 * 60_000)
      throw new Error(s.armFailure ?? "This terminal did not answer like a shell a moment ago. Connect it at a prompt by hand.");
    // The handshake is typed into the terminal: only where a shell is waiting, never into a running program.
    if (!atShellPrompt(s.tail))
      throw new Error("This terminal is not at a shell prompt (a program is running in it, or it is waiting for input). Leave it at a prompt, or connect it by hand.");
    const labelLower = s.view.label.toLowerCase();
    const outLower = s.output.toLowerCase();
    const inferredShell: ShellKind =
      s.view.shell ??
      fallbackShell ??
      (s.view.kind === "local" && process.platform === "win32"
        ? labelLower.includes("pwsh")
          ? "pwsh"
          : labelLower.includes("powershell") || outLower.includes("windows powershell") || /^ps [a-z]:\\/im.test(s.output)
            ? "powershell"
            : labelLower.includes("bash") || labelLower.includes("wsl")
              ? "bash"
              : "cmd"
        : "bash");
    const prevOwner = s.view.owner;
    s.view.owner = undefined;
    try {
      await this.arm(id, inferredShell);
      s.armFailedAt = undefined;
    } catch (error) {
      s.armFailedAt = Date.now();
      s.armFailure = `This terminal did not answer like a ${inferredShell} shell (${error instanceof Error ? error.message : String(error)}). sshs3 runs commands in bash, zsh, sh, fish and PowerShell; connect it by hand at such a prompt.`;
      throw new Error(s.armFailure, { cause: error });
    } finally {
      if (prevOwner && !s.view.owner && s.view.state === "ready") {
        s.view.owner = prevOwner;
      }
    }
    return { ...s.view };
  }

  /**
   * Waits until a terminal that was just opened shows a shell prompt and has
   * been quiet for a moment. A terminal the hub opens for itself is connected
   * to only after this: the handshake is typed, and typed into a connection
   * that is still being made it is lost, or answered too late to be heard.
   * Fails with what the terminal last showed (ssh's own error, usually).
   *
   * A last line that reads as a prompt is taken after a short quiet. A prompt
   * of a shape this does not know (a theme's arrow, a bare "~") is taken once
   * the terminal has shown something and been quiet for longer; the handshake
   * then finds out whether a shell is there. A question for a password is
   * never a prompt.
   */
  async whenAtPrompt(id: string, timeoutMs = 30_000, quietMs = 300, settledMs = 1500): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = this.sessions.get(id);
      if (!s) throw new Error("No such terminal. It may have been closed; pick one that is open.");
      const last = lastVisibleLine(s.tail ?? "").slice(-300);
      if (s.view.state === "disconnected")
        throw new Error(last ? `The connection ended before a shell prompt came. It last showed: ${last}` : "The connection ended before a shell prompt came.");
      const quiet = Date.now() - (s.fedAt ?? 0);
      if (last && !atSecretPrompt(s.tail ?? "") && quiet >= (atShellPrompt(s.tail) ? quietMs : settledMs)) return;
      if (Date.now() >= until)
        throw new Error(
          `No shell prompt within ${Math.round(timeoutMs / 1000)} seconds. ${last ? `The terminal last showed: ${last}` : "The terminal showed nothing."}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Connects to a terminal the hub opened for itself: once its prompt is there, never before. */
  async armAtPrompt(id: string, shell: ShellKind, timeoutMs = 30_000): Promise<void> {
    await this.whenAtPrompt(id, timeoutMs);
    await this.arm(id, shell);
  }

  async arm(id: string, shell: ShellKind): Promise<void> {
    const s = this.require(id);
    if (s.view.owner || s.pending) throw new Error("Terminal is in use");
    // This is an explicit user action after checking that the prompt is idle and the target is correct.
    s.view.shell = shell;
    s.view.state = "ready";
    await this.execute(
      id,
      s.view.generation,
      "__handshake__",
      shell === "cmd"
        ? "ver >nul"
        : shell === "powershell" || shell === "pwsh"
          ? "$null"
          : shell === "fish"
            ? "true"
            : ":",
      10_000,
      true,
    );
  }

  claim(id: string, generation: string, owner: string): void {
    const s = this.require(id);
    if (
      s.view.generation !== generation ||
      s.view.state !== "ready" ||
      !s.view.shell
    )
      throw new Error(
        "Terminal changed or is not ready. Reconnect AI at an idle prompt.",
      );
    if (s.view.owner && s.view.owner !== owner)
      throw new Error("Another task owns this terminal");
    s.view.owner = owner;
    this.emit("claimed", { ...s.view }, owner);
    this.emit("changed");
  }

  release(owner: string): void {
    for (const s of this.sessions.values()) {
      if (s.view.owner !== owner) continue;
      this.emit("released", { ...s.view }, owner);
      if (s.pending) this.takeover(s.view.id);
      else {
        s.view.owner = undefined;
        this.emit("changed");
      }
    }
  }

  execute(
    id: string,
    generation: string,
    owner: string,
    command: string,
    timeout = 120_000,
    handshake = false,
  ): Promise<CommandResult> {
    const s = this.require(id);
    if (
      s.view.generation !== generation ||
      s.view.state !== "ready" ||
      !s.view.shell ||
      s.pending
    )
      throw new Error("Terminal is not ready for this command");
    if (!handshake && s.view.owner !== owner)
      throw new Error("Terminal ownership was revoked");
    // Something half-typed at the prompt would run together with the command: never write over it.
    if (!handshake && s.inputBuffer.trim())
      throw new Error("Something is typed at the prompt of this terminal. Clear it, or take control, before the agent runs anything there.");
    const nonce = crypto.randomBytes(16).toString("hex");
    const envelope = commandEnvelope(s.view.shell, command, nonce);
    if (!handshake) {
      this.issued.set(nonce, command);
      if (this.issued.size > 200) this.issued.delete(this.issued.keys().next().value as string);
    }
    // The command as it was asked for, before the envelope around it: a recording marks it.
    if (!handshake) this.emit("executing", id, command, owner);
    s.view.state = "busy";
    // A pseudo console that passes markers ahead of text: only for a shell whose output is plain text
    // (PowerShell's comes in frames of its own), and not for a stream that is no pseudo console.
    const late =
      this.options.lateOutput === true &&
      s.view.kind !== "k8s" &&
      s.view.shell !== "powershell" &&
      s.view.shell !== "pwsh" &&
      s.view.shell !== "cmd";
    const promise = new Promise<CommandResult>((resolve, reject) => {
      s.pending = {
        frames: new CommandFrames(nonce, 128_000, {
          command,
          shell: s.view.shell,
          handshake,
          ...(late ? { lateOutput: { prompt: s.promptLine } } : {}),
        }),
        handshake,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.invalidate(
            id,
            "Command status is unknown after timeout. Inspect the terminal; the command was not retried.",
          );
        }, timeout),
      };
      try {
        s.write(envelope);
      } catch (error) {
        this.invalidate(
          id,
          error instanceof Error ? error.message : "Terminal write failed",
        );
      }
    });
    this.emit("changed");
    return promise;
  }

  /**
   * Gives the terminal back to the person. `interrupt`: stop what the agent is
   * running (Ctrl-C), when the person asked for control with a button rather
   * than by typing — their own keys, Ctrl-C included, go through by themselves.
   */
  /** The person's terminal was resized: kept for a recording to replay at the right size. */
  resized(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    s.cols = Math.round(cols);
    s.rows = Math.round(rows);
    this.emit("resized", id, s.cols, s.rows);
  }

  size(id: string): { cols?: number; rows?: number } {
    const s = this.sessions.get(id);
    return { cols: s?.cols, rows: s?.rows };
  }

  takeover(id: string, options: { interrupt?: boolean } = {}): void {
    const s = this.require(id);
    const owner = s.view.owner;
    const running = Boolean(s.pending);
    this.invalidate(
      id,
      "Control returned to the user. Inspect the terminal before resuming.",
    );
    if (running && options.interrupt !== false) s.write("\x03");
    if (owner) this.emit("takeover", owner);
  }

  invalidate(id: string, reason: string, disconnected = false): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const owner = s.view.owner;
    if (s.pending) {
      clearTimeout(s.pending.timer);
      clearTimeout(s.pending.lateTimer);
      s.pending.reject(new Error(reason));
      s.pending = undefined;
    }
    s.view.generation = crypto.randomUUID();
    // Whatever held the terminal lets go of it here too, so a recording ends with the run that made it.
    if (owner) this.emit("released", { ...s.view }, owner);
    s.view.owner = undefined;
    s.view.state = disconnected ? "disconnected" : "unknown";
    s.view.updatedAt = Date.now();
    if (owner) this.emit("invalidated", owner, reason);
    this.emit("changed");
  }

  private require(id: string): LiveTerminal {
    const s = this.sessions.get(id);
    // Two different things to a person: an id that names nothing, and a terminal whose connection ended.
    if (!s) throw new Error("No such terminal. It may have been closed; pick one that is open.");
    if (s.view.state === "disconnected")
      throw new Error("Terminal is disconnected");
    return s;
  }

  dispose(): void {
    for (const id of this.sessions.keys())
      this.invalidate(id, "Application shutting down", true);
    this.sessions.clear();
    this.removeAllListeners();
  }
}
