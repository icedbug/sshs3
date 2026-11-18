import type { ShellKind } from "../../../shared/types/aiHub";

export type Osc133Phase = "A" | "B" | "C" | "D";

export interface Osc133Marker {
  phase: Osc133Phase;
  exitCode?: number;
  index: number;
  endIndex: number;
}

export interface ParsedOscMarkers {
  osc133: Osc133Marker[];
  lastPhase?: Osc133Phase;
  lastExitCode?: number;
  promptActive?: boolean;
  cwd?: string;
}

export interface ShellAdapterCapabilities {
  shell: ShellKind;
  family: "posix" | "fish" | "powershell" | "cmd";
  supportsOsc133: boolean;
  usesStructuredDataFrames: boolean;
  supportsSubshellIsolation: boolean;
  handshakeCommand: string;
}

export function buildHandshakeCommand(shell: ShellKind): string {
  if (shell === "cmd") return "ver >nul";
  if (shell === "powershell" || shell === "pwsh") return "$null";
  if (shell === "fish") return "true";
  return ":";
}

export function getShellAdapterCapabilities(shell: ShellKind): ShellAdapterCapabilities {
  if (shell === "powershell" || shell === "pwsh") {
    return {
      shell,
      family: "powershell",
      supportsOsc133: true,
      usesStructuredDataFrames: true,
      supportsSubshellIsolation: false,
      handshakeCommand: buildHandshakeCommand(shell),
    };
  }
  if (shell === "cmd") {
    return {
      shell,
      family: "cmd",
      supportsOsc133: false,
      usesStructuredDataFrames: false,
      supportsSubshellIsolation: false,
      handshakeCommand: buildHandshakeCommand(shell),
    };
  }
  if (shell === "fish") {
    return {
      shell,
      family: "fish",
      supportsOsc133: true,
      usesStructuredDataFrames: false,
      supportsSubshellIsolation: false,
      handshakeCommand: buildHandshakeCommand(shell),
    };
  }
  return {
    shell,
    family: "posix",
    supportsOsc133: shell === "bash" || shell === "zsh",
    usesStructuredDataFrames: false,
    supportsSubshellIsolation: true,
    handshakeCommand: buildHandshakeCommand(shell),
  };
}

export function detectShellFromHint(hint: {
  shell?: ShellKind;
  label?: string;
  output?: string;
  shellBinary?: string;
  kind?: "local" | "ssh" | "k8s";
  platform?: NodeJS.Platform;
  fallback?: ShellKind;
}): ShellKind {
  if (hint.shell) return hint.shell;
  if (hint.fallback) return hint.fallback;
  const bin = (hint.shellBinary ?? "").toLowerCase();
  const label = (hint.label ?? "").toLowerCase();
  const out = hint.output ?? "";
  const outLower = out.toLowerCase();
  const platform = hint.platform ?? process.platform;
  // A terminal's name is what a person called it. It says which shell runs there only where the tab is
  // named after the program it starts: a terminal on this machine. A server called "cmd-gateway" or
  // "fish-market-db" runs neither, and a wrong guess types the wrong handshake into it. So a name counts
  // for a Windows shell only on a local terminal on Windows, and for fish only on a local terminal.
  // (bash, zsh, sh and dash take the same commands, so a name may tell those apart anywhere.)
  const local = hint.kind === "local";
  const namesWindowsShell = local && platform === "win32";

  if (bin.includes("pwsh") || (namesWindowsShell && label.includes("pwsh"))) return "pwsh";
  if (
    bin.includes("powershell") ||
    (namesWindowsShell && label.includes("powershell")) ||
    outLower.includes("windows powershell") ||
    /^ps [a-z]:\\/im.test(out)
  ) {
    return "powershell";
  }
  if (bin.includes("cmd.exe") || (namesWindowsShell && /\bcmd\b/.test(label)) || /^[a-z]:\\[^>]*>/im.test(out)) {
    return "cmd";
  }
  if (bin.includes("zsh") || /\bzsh\b/.test(label)) return "zsh";
  if (bin.includes("fish") || (local && /\bfish\b/.test(label))) return "fish";
  if (bin.includes("dash") || /\bdash\b/.test(label)) return "dash";
  if (/\b(?:wsl|ubuntu|debian|alpine|fedora)\b/.test(label) || label.includes("bash") || bin.includes("bash")) {
    return "bash";
  }
  if (hint.kind === "local" && platform === "win32") {
    return "cmd";
  }
  return "bash";
}

/**
 * Extracts OSC 133 shell-integration markers (A/B/C/D) and OSC 7 / OSC 9;9 CWD updates.
 */
export function parseOscMarkers(text: string): ParsedOscMarkers {
  const osc133: Osc133Marker[] = [];
  let lastPhase: Osc133Phase | undefined;
  let lastExitCode: number | undefined;
  let cwd: string | undefined;

  if (!text) return { osc133 };

  // eslint-disable-next-line no-control-regex -- matching terminal OSC sequences is the point
  const osc133Re = /\x1b\]133;([ABCD])([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = osc133Re.exec(text)) !== null) {
    const phase = m[1] as Osc133Phase;
    let exitCode: number | undefined;
    if (phase === "D" && m[2].startsWith(";")) {
      const codeMatch = /^(-?\d+)/.exec(m[2].slice(1).trim());
      if (codeMatch) {
        exitCode = Number(codeMatch[1]);
        lastExitCode = exitCode;
      }
    }
    osc133.push({
      phase,
      ...(exitCode !== undefined ? { exitCode } : {}),
      index: m.index,
      endIndex: m.index + m[0].length,
    });
    lastPhase = phase;
  }

  // OSC 7: file://host/path
  // eslint-disable-next-line no-control-regex -- matching terminal OSC sequences is the point
  const osc7Re = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = osc7Re.exec(text)) !== null) {
    try {
      cwd = decodeURIComponent(m[1]);
    } catch {
      cwd = m[1];
    }
  }

  // OSC 9;9: Windows Terminal / PowerShell CWD notification
  // eslint-disable-next-line no-control-regex -- matching terminal OSC sequences is the point
  const osc99Re = /\x1b\]9;9;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  while ((m = osc99Re.exec(text)) !== null) {
    const next = m[1].trim();
    if (next) cwd = next;
  }

  const promptActive =
    lastPhase === undefined
      ? undefined
      : lastPhase === "A" || lastPhase === "B" || lastPhase === "D";

  return {
    osc133,
    ...(lastPhase !== undefined ? { lastPhase } : {}),
    ...(lastExitCode !== undefined ? { lastExitCode } : {}),
    ...(promptActive !== undefined ? { promptActive } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
function fishQuote(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A complete parsed shell statement: completion is an explicit correlated marker, never silence. */
export function commandEnvelope(
  shell: ShellKind,
  command: string,
  nonce: string,
): string {
  if (!/^[a-f0-9]{32}$/.test(nonce))
    throw new Error("Invalid command correlation ID");
  // Control sequences could change terminal mode or smuggle another submission.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command))
    throw new Error("Control characters are not allowed in commands");
  const prefix = `SSHS3;${nonce}`;
  if (shell === "powershell" || shell === "pwsh") {
    const body = Buffer.from(command, "utf8").toString("base64");
    return `[Console]::Write(([char]27)+']777;${prefix};BEGIN'+[char]7); $__sshs3_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}')); Write-Host $__sshs3_cmd; $global:LASTEXITCODE=0; try { . { . ([scriptblock]::Create($__sshs3_cmd)); $__sshs3_ok=$?; $__sshs3_rc=0; if (-not $__sshs3_ok) { $__sshs3_rc=1 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__sshs3_rc=$LASTEXITCODE } } *>&1 | ForEach-Object { $__sshs3_line=($_ | Out-String); [Console]::Write($__sshs3_line); for ($__sshs3_i=0; $__sshs3_i -lt $__sshs3_line.Length; $__sshs3_i+=2000) { $__sshs3_piece=$__sshs3_line.Substring($__sshs3_i,[Math]::Min(2000,$__sshs3_line.Length-$__sshs3_i)); [Console]::Write(([char]27)+']777;${prefix};DATA;'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__sshs3_piece))+[char]7) } } } catch { Write-Error $_; $__sshs3_rc=1 }; [Console]::Write(([char]27)+']777;${prefix};END;'+$__sshs3_rc+';'+$PWD.Path+[char]7)\r`;
  }
  if (shell === "cmd") {
    const content = Buffer.from(
      "@echo off\r\n" + command.replace(/\r?\n/g, "\r\n") + "\r\n",
      "utf8",
    ).toString("base64");
    const stage = `$t=$env:TEMP; [IO.File]::WriteAllText("$t\\sshs3-${nonce}.cmd",[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${content}')),[Text.Encoding]::Default); [IO.File]::WriteAllText("$t\\sshs3-${nonce}-end.cmd",'@set "_sshs3_rc='+([char]37)+'errorlevel'+([char]37)+'"'+"\`r\`n",[Text.Encoding]::Default); [Console]::Write(([char]27)+']777;${prefix};BEGIN'+[char]7)`;
    const envelope = `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(stage, "utf16le").toString("base64")} && (call "%TEMP%\\sshs3-${nonce}.cmd" & call "%TEMP%\\sshs3-${nonce}-end.cmd" & del /q "%TEMP%\\sshs3-${nonce}.cmd" "%TEMP%\\sshs3-${nonce}-end.cmd" 2>nul & powershell -NoLogo -NoProfile -NonInteractive -Command "$rc=if ($env:_sshs3_rc -match '^-?\\d+$') { $env:_sshs3_rc } else { 1 }; [Console]::Write(([char]27)+']777;${prefix};END;'+$rc+';'+$PWD.Path+[char]7)")\r`;
    if (envelope.length > 8000)
      throw new Error(
        "Command exceeds cmd's input limit. Split it into smaller approved steps.",
      );
    return envelope;
  }
  if (shell === "fish") {
    return `printf '\\033]777;${prefix};BEGIN\\007'; eval ${fishQuote(command)}; set -l __sshs3_rc $status; printf '\\033]777;${prefix};END;%s;%s\\007' $__sshs3_rc "$PWD"\r`;
  }
  // The command runs in a subshell: what it defines (a function called printf, say) cannot reach the
  // line that reports its exit code, and an `exit` or `cd` in it does not end or move the person's shell.
  return `printf '\\033]777;${prefix};BEGIN\\007'; (eval ${quote(command)}); __sshs3_rc=$?; printf '\\033]777;${prefix};END;%s;%s\\007' "$__sshs3_rc" "$PWD"\r`;
}

export interface CommandResult {
  output: string;
  exitCode: number;
  cwd: string;
}
export interface CommandFrameOptions {
  command?: string;
  shell?: ShellKind;
  handshake?: boolean;
  /**
   * The terminal may deliver text that was printed BEFORE a marker only AFTER
   * it. Windows' pseudo console does this: it passes the marker (an OSC it does
   * not know) straight through, and repaints the text printed in the same burst
   * a moment later. With this set, the end marker does not end the frame: what
   * follows is collected until the shell's prompt is back (`prompt`, when it is
   * known) or the caller calls `settle()`.
   */
  lateOutput?: {
    /** The last line of the shell's prompt as it was last seen, without escape sequences. */
    prompt?: string;
  };
}
function cleanInternalTitleOsc(text: string): string {
  // Strip Windows cmd.exe window-title OSC 0 sequences that leak the internal PowerShell wrapper
  return text.replace(
    // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
    /\x1b\]0;[^\x07\x1b]*(?:EncodedCommand|\]777;SSHS3;)[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    "",
  );
}

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>78]/y;

/**
 * The characters of a text that a person would see, without white space, and
 * for each of them where it ends in the text. A pseudo console repaints what
 * a shell printed (a space becomes "cursor right", a long line is wrapped), so
 * text is compared on these and never on the raw bytes.
 */
function seen(text: string): { chars: string; ends: number[] } {
  let chars = "";
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b") {
      ESCAPE.lastIndex = i;
      const m = ESCAPE.exec(text);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    const ch = text[i++];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch < " ") continue;
    chars += ch;
    ends.push(i);
  }
  return { chars, ends };
}

/** A line as a person would see it: escape sequences gone, "cursor right" as spaces, trimmed. */
export function visibleLine(line: string): string {
  return (
    line
      // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
      .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(200, Number(n) || 1)))
      // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>78]|[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .trim()
  );
}

/** The last line of a text that shows anything, as a person would see it. */
export function lastVisibleLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = visibleLine(lines[i]);
    if (line) return line;
  }
  return "";
}

/**
 * A prompt that names something (`ops@app-01:~$`, `[root@db-01 ~]#`) and is
 * not just a sign: a bare `$`, `#` or `>` ends many lines of ordinary output,
 * so where the output ends before such a prompt is not known from it.
 */
const distinctivePrompt = (prompt: string): boolean => prompt.length >= 6 && /[A-Za-z0-9]{2}/.test(prompt) && /[$#%>❯]$/.test(prompt);

/**
 * Where in `raw` (one line as the terminal sent it; `line` is what a person
 * sees of it) the known prompt begins, when the line is output with the
 * prompt right after it. Undefined when it is not, or cannot be told.
 */
function promptGluedAt(raw: string, line: string, prompt: string): number | undefined {
  if (!distinctivePrompt(prompt) || line.length <= prompt.length || !line.endsWith(prompt)) return undefined;
  const got = seen(raw);
  const want = seen(prompt).chars;
  if (!want || got.chars.length <= want.length || !got.chars.endsWith(want)) return undefined;
  return got.ends[got.chars.length - want.length - 1];
}

/** How much of the typed line holds the frame's random id: `printf '\033]777;SSHS3;` and the 32 characters after it. */
const ECHO_HEAD = 54;

export const LATE_OUTPUT_NOTE =
  "[sshs3: the text from the marked line on reached the terminal after the command had ended. It may end with the shell's prompt, which is not output.]";

export class CommandFrames {
  private carry = "";
  private output = "";
  private displayBuffer = "";
  private started = false;
  private structuredOutput: string | undefined;
  /** What the terminal showed right before the frame began: the end of it is the echo of what was typed. */
  private before = "";
  /** Set once the end marker was read while late output is waited for. */
  private ended: { exitCode: number; cwd: string } | undefined;
  private trailing = "";
  /** What was typed to run the command, as seen characters: its echo is not the command's output. */
  private readonly typed: string;
  constructor(
    private readonly nonce: string,
    private readonly maxOutput = 128_000,
    private readonly options: CommandFrameOptions = {},
  ) {
    const shell = options.shell;
    // Only where the envelope is typed as it stands (PowerShell and cmd carry the command encoded).
    const plain = options.command !== undefined && shell !== undefined && shell !== "powershell" && shell !== "pwsh" && shell !== "cmd";
    let typed = "";
    if (plain) {
      try {
        typed = seen(commandEnvelope(shell, options.command!, nonce)).chars;
      } catch {
        typed = "";
      }
    }
    this.typed = typed;
  }
  get commandText(): string | undefined {
    return this.options.command;
  }
  /** The end marker was read and the frame waits for text the terminal delivers late. */
  get awaitingLate(): boolean {
    return this.ended !== undefined;
  }
  drainDisplay(): string {
    const out = this.displayBuffer;
    this.displayBuffer = "";
    return out;
  }
  feed(chunk: string): CommandResult | undefined {
    if (this.ended) {
      const text = cleanInternalTitleOsc(chunk);
      this.trailing = (this.trailing + text).slice(-this.maxOutput);
      if (text) this.displayBuffer += text;
      return this.promptIsBack() ? this.settle() : undefined;
    }
    this.carry += chunk;
    while (this.carry) {
      const start = this.carry.indexOf("\x1b]777;");
      if (start === -1) {
        const keep = Math.min(this.carry.length, 8);
        this.append(this.carry.slice(0, -keep || undefined));
        this.carry = this.carry.slice(-keep);
        return;
      }
      this.append(this.carry.slice(0, start));
      this.carry = this.carry.slice(start);
      const bell = this.carry.indexOf("\x07");
      const st = this.carry.indexOf("\x1b\\");
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (this.carry.length > 16_000)
          throw new Error("Oversized shell marker");
        return;
      }
      const marker = this.carry.slice(6, end);
      this.carry = this.carry.slice(end + (end === st ? 2 : 1));
      if (marker === `SSHS3;${this.nonce};BEGIN`) {
        this.started = true;
        if (!this.options.handshake) {
          const shell = this.options.shell;
          if (shell === "powershell" || shell === "pwsh") {
            this.displayBuffer += "\x1b[?25h";
          } else if (this.options.command) {
            this.displayBuffer += `\x1b[?25h${this.options.command.replace(/\r?\n/g, "\r\n")}\r\n`;
          }
        }
      }
      if (this.started && marker.startsWith(`SSHS3;${this.nonce};DATA;`)) {
        const encoded = marker.split(";").slice(3).join(";");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
          throw new Error("Invalid shell output frame");
        this.structuredOutput = (
          (this.structuredOutput ?? "") +
          Buffer.from(encoded, "base64").toString("utf8")
        ).slice(-this.maxOutput);
      }
      if (this.started && marker.startsWith(`SSHS3;${this.nonce};END;`)) {
        const parts = marker.split(";");
        if (!/^-?\d+$/.test(parts[3] ?? ""))
          throw new Error("Invalid shell completion");
        const trailing = cleanInternalTitleOsc(this.carry);
        this.carry = "";
        if (this.options.handshake) {
          this.displayBuffer += `\x1b[?25h\r\x1b[2K${trailing.replace(/^[\r\n]+/, "")}`;
        } else if (trailing) {
          this.displayBuffer += `\x1b[?25h${trailing}`;
        }
        const ended = { exitCode: Number(parts[3]), cwd: parts.slice(4).join(";") };
        // Output that came in frames of its own cannot arrive late: nothing to wait for.
        if (!this.options.lateOutput || this.structuredOutput !== undefined)
          return { output: cleanInternalTitleOsc(this.structuredOutput ?? this.withoutEcho(this.output).text), ...ended };
        this.ended = ended;
        this.trailing = trailing;
        return this.promptIsBack() ? this.settle() : undefined;
      }
    }
  }

  /**
   * Ends a frame that waits for late output with what has arrived. Text that
   * came after the end marker is the command's when the known prompt follows
   * it; when the prompt is not recognised it is kept too, and marked, because
   * where the output ends cannot be known then.
   */
  settle(): CommandResult {
    if (!this.ended) throw new Error("The command has not ended");
    const ended = this.ended;
    const inFrame = this.withoutEcho(this.output);
    const late = this.withoutEcho(this.trailing, inFrame.left, this.options.handshake === true).text;
    const split = this.splitAtPrompt(late);
    let output = inFrame.text;
    if (split !== undefined) {
      // Blank lines between the marker and the prompt are the terminal's, not the command's.
      const rest = late.slice(0, split);
      if (visibleLine(rest.replace(/\n/g, " "))) output += rest;
    } else if (!this.options.handshake && visibleLine(late.replace(/\n/g, " ")))
      output = `${output}${output && !output.endsWith("\n") ? "\n" : ""}[sshs3: late text begins here]\n${late}${late.endsWith("\n") ? "" : "\n"}${LATE_OUTPUT_NOTE}`;
    return { output: cleanInternalTitleOsc(output).slice(-this.maxOutput), ...ended };
  }

  /**
   * The last line the terminal showed after the end marker, once the echo of
   * what was typed is taken away: after a handshake, which prints nothing,
   * that is the shell's prompt.
   */
  promptSeen(): string {
    if (!this.ended) return "";
    const left = this.withoutEcho(this.output).left;
    return lastVisibleLine(this.withoutEcho(this.trailing, left, true).text).slice(0, 400);
  }

  private promptIsBack(): boolean {
    return this.splitAtPrompt(this.trailing) !== undefined;
  }

  /**
   * Where the known prompt begins at the end of `text`; undefined when the
   * text does not end with it. The prompt is a line of its own, or it stands
   * right after output that did not end in a line break (`curl` printing
   * JSON, `printf` without `\n`): the shell prints its prompt wherever the
   * cursor is. The second is only taken for a prompt that cannot be mistaken
   * for the end of a line of output.
   */
  private splitAtPrompt(text: string): number | undefined {
    const osc = parseOscMarkers(text);
    const lastA = [...osc.osc133].reverse().find((m) => m.phase === "A");
    const lastB = [...osc.osc133].reverse().find((m) => m.phase === "B");
    if (lastA && lastB && lastB.index > lastA.index && osc.lastPhase !== "C") {
      return lastA.index;
    }
    const prompt = this.options.lateOutput?.prompt;
    if (!prompt) return undefined;
    let end = text.length;
    for (;;) {
      const nl = text.lastIndexOf("\n", end - 1);
      const raw = text.slice(nl + 1, end);
      const line = visibleLine(raw);
      if (line) {
        if (line === prompt) return nl + 1;
        const glued = promptGluedAt(raw, line, prompt);
        return glued === undefined ? undefined : nl + 1 + glued;
      }
      if (nl < 0) return undefined;
      end = nl;
    }
  }

  /**
   * `text` without the rest of the echo of what was typed. The terminal echoes
   * the typed line before the shell runs it; when the begin marker overtakes
   * the end of that echo, the echo's rest reads as the start of the output.
   * It is taken away only when it is exactly what is still missing of the
   * typed line (which carries this frame's own random id); anything else is
   * left as it is. `left`: what is still missing after this text.
   */
  private withoutEcho(text: string, missing?: string, anywhere = false): { text: string; left: string } {
    const expect = missing ?? this.echoMissing();
    if (!expect || !text) return { text, left: expect };
    const got = seen(text);
    if (!got.chars) return { text, left: expect };
    const cutAfter = (count: number): string => text.slice(got.ends[count - 1]).replace(/^[ \t]*\r?\n?/, "");
    if (got.chars.startsWith(expect)) return { text: cutAfter(expect.length), left: "" };
    // All of it is echo so far, and more of the echo is still to come. Only once the frame's own id
    // is among what was matched: a short output that happens to read like the typed line stays output.
    if (expect.startsWith(got.chars) && this.typed.length - expect.length + got.chars.length >= ECHO_HEAD)
      return { text: "", left: expect.slice(got.chars.length) };
    if (anywhere && expect === this.typed) {
      const at = got.chars.indexOf(expect);
      if (at >= 0) return { text: cutAfter(at + expect.length), left: "" };
    }
    return { text, left: "" };
  }

  /** What of the typed line had not been echoed when the frame began. */
  private echoMissing(): string {
    if (!this.typed) return "";
    const before = seen(this.before).chars;
    // The typed line opens with this frame's id: where that was echoed, the echo began.
    // (Through `;BEGIN`: the line names the id a second time, where it prints the end marker.)
    const head = this.typed.slice(0, ECHO_HEAD + 6);
    const at = before.lastIndexOf(head);
    if (at >= 0) {
      const echoed = before.slice(at);
      return this.typed.startsWith(echoed) ? this.typed.slice(echoed.length) : "";
    }
    for (let k = Math.min(head.length - 1, before.length); k > 0; k--)
      if (before.endsWith(this.typed.slice(0, k))) return this.typed.slice(k);
    return this.typed;
  }

  private append(text: string): void {
    if (this.started) {
      this.output = (this.output + text).slice(-this.maxOutput);
      if (!this.options.handshake && text) {
        this.displayBuffer += cleanInternalTitleOsc(text);
      }
    } else if (this.typed && text) {
      this.before = (this.before + text).slice(-(this.typed.length * 3 + 4000));
    }
  }
}
