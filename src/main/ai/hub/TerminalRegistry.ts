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
  type CommandResult,
} from "./shellAdapters";
import { boundedContext } from "./privacy";

interface LiveTerminal {
  view: TerminalSession;
  write: (data: string) => void;
  output: string;
  inputBuffer: string;
  lastSubmittedCommand?: string;
  lastSubmittedAt?: number;
  trimPostHandshakeNewline?: boolean;
  pending?: {
    frames: CommandFrames;
    handshake: boolean;
    resolve: (value: CommandResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
}

export interface DetectedCommandActivity {
  kind: "command" | "config-edit" | "service" | "deploy";
  summary: string;
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
  const normalized = line
    .replace(/^(?:sudo\s+(?:-[A-Za-z]+\s+)*|env\s+\S+=\S+\s+)*/, "")
    .trim();

  // Config / file edits
  const editorMatch =
    /^(?:vim?|nvim|nano|emacs|micro|code|subl|sed\s+-i|tee(?:\s+-a)?)\s+(.+)$/i.exec(
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
    /^(?:docker(?:\s+compose)?|docker-compose|podman|nerdctl)\s+(?:up|down|restart|stop|start|rm|pull|build|run|exec)\b/i.test(
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
  private lastFailures = new Map<string, TerminalCommandFailure>();
  private observing = false;

  observe(enabled: boolean): void {
    this.observing = enabled;
    if (!enabled)
      for (const session of this.sessions.values()) session.output = "";
  }

  failures(): Record<string, TerminalCommandFailure> {
    return Object.fromEntries(this.lastFailures.entries());
  }

  dismissFailure(sessionId: string): void {
    if (this.lastFailures.delete(sessionId)) {
      this.emit("changed");
    }
  }

  recordFailure(failure: TerminalCommandFailure): void {
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

  feed(id: string, data: string): string {
    const s = this.sessions.get(id);
    if (!s) return data;
    if (s.pending) {
      try {
        const result = s.pending.frames.feed(data);
        const display = s.pending.frames.drainDisplay();
        if (this.observing && display && !s.pending.handshake) {
          s.output = (s.output + display).slice(-128_000);
        }
        if (result) {
          const pending = s.pending;
          clearTimeout(pending.timer);
          s.pending = undefined;
          s.trimPostHandshakeNewline = pending.handshake;
          s.view.state = "ready";
          s.view.cwd = result.cwd;
          s.view.updatedAt = Date.now();
          if (!pending.handshake && result.exitCode !== 0) {
            this.lastFailures.set(id, {
              sessionId: id,
              label: s.view.label,
              command: pending.frames.commandText || s.lastSubmittedCommand || "",
              exitCode: result.exitCode,
              snippet: boundedContext(result.output, 1500),
              at: Date.now(),
            });
          } else if (!pending.handshake && result.exitCode === 0) {
            this.lastFailures.delete(id);
          }
          pending.resolve({ ...result, output: boundedContext(result.output) });
          this.emit("changed");
        }
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
      clean = clean.replace(/^(?:\r?\n)+/, "");
    }
    if (this.observing && clean) {
      s.output = (s.output + clean).slice(-128_000);
    }
    this.detectHumanOutputFailure(id, s, clean);
    return clean;
  }

  private detectHumanOutputFailure(
    id: string,
    s: LiveTerminal,
    chunk: string,
  ): void {
    if (!chunk) return;
    // 1. Check OSC 133;D;<exitCode> shell integration marker
    const oscMatch = /\x1b\]133;D;([0-9]+)(?:\x07|\x1b\\)/.exec(chunk);
    if (oscMatch) {
      const code = Number(oscMatch[1]);
      if (code !== 0) {
        this.lastFailures.set(id, {
          sessionId: id,
          label: s.view.label,
          command: s.lastSubmittedCommand || "",
          exitCode: code,
          snippet: boundedContext(s.output.slice(-1500), 1500),
          at: Date.now(),
        });
        this.emit("changed");
      } else if (this.lastFailures.delete(id)) {
        this.emit("changed");
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

  /** Called on ALL human write paths, including snippets and paste. */
  humanWrite(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.view.owner || s.pending)
      throw new Error(
        "AI owns this terminal. Choose Take control before typing.",
      );
    s.view.state = "unknown";
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
    if (s.pending) {
      if (data.includes("\x03")) {
        this.takeover(id);
      }
      return;
    }
    // Strip ANSI escape sequences (arrow keys, function keys, bracketed paste markers)
    const cleaned = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    for (const ch of cleaned) {
      if (ch === "\x7f" || ch === "\x08") {
        s.inputBuffer = s.inputBuffer.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        s.inputBuffer = "";
      } else if (ch === "\r" || ch === "\n") {
        const submitted = s.inputBuffer.trim();
        s.inputBuffer = "";
        if (submitted) {
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
    } finally {
      if (prevOwner && !s.view.owner && s.view.state === "ready") {
        s.view.owner = prevOwner;
      }
    }
    return { ...s.view };
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
    this.emit("changed");
  }

  release(owner: string): void {
    for (const s of this.sessions.values()) {
      if (s.view.owner !== owner) continue;
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
    const nonce = crypto.randomBytes(16).toString("hex");
    const envelope = commandEnvelope(s.view.shell, command, nonce);
    s.view.state = "busy";
    const promise = new Promise<CommandResult>((resolve, reject) => {
      s.pending = {
        frames: new CommandFrames(nonce, 128_000, {
          command,
          shell: s.view.shell,
          handshake,
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

  takeover(id: string): void {
    const s = this.require(id);
    const owner = s.view.owner;
    const running = Boolean(s.pending);
    this.invalidate(
      id,
      "Control returned to the user. Inspect the terminal before resuming.",
    );
    if (running) s.write("\x03");
    if (owner) this.emit("takeover", owner);
  }

  invalidate(id: string, reason: string, disconnected = false): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const owner = s.view.owner;
    if (s.pending) {
      clearTimeout(s.pending.timer);
      s.pending.reject(new Error(reason));
      s.pending = undefined;
    }
    s.view.generation = crypto.randomUUID();
    s.view.owner = undefined;
    s.view.state = disconnected ? "disconnected" : "unknown";
    s.view.updatedAt = Date.now();
    if (owner) this.emit("invalidated", owner, reason);
    this.emit("changed");
  }

  private require(id: string): LiveTerminal {
    const s = this.sessions.get(id);
    if (!s || s.view.state === "disconnected")
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
