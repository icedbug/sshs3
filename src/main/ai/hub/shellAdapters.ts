import type { ShellKind } from "../../../shared/types/aiHub";

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
    return `[Console]::Write(([char]27)+']777;${prefix};BEGIN'+[char]7); $__sshs3_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}')); Write-Host $__sshs3_cmd; $global:LASTEXITCODE=0; try { . { . ([scriptblock]::Create($__sshs3_cmd)); $__sshs3_ok=$?; $__sshs3_rc=0; if (-not $__sshs3_ok) { $__sshs3_rc=1 }; if ($LASTEXITCODE -ne 0) { $__sshs3_rc=$LASTEXITCODE } } *>&1 | ForEach-Object { $__sshs3_line=($_ | Out-String); [Console]::Write($__sshs3_line); for ($__sshs3_i=0; $__sshs3_i -lt $__sshs3_line.Length; $__sshs3_i+=2000) { $__sshs3_piece=$__sshs3_line.Substring($__sshs3_i,[Math]::Min(2000,$__sshs3_line.Length-$__sshs3_i)); [Console]::Write(([char]27)+']777;${prefix};DATA;'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__sshs3_piece))+[char]7) } } } catch { Write-Error $_; $__sshs3_rc=1 }; [Console]::Write(([char]27)+']777;${prefix};END;'+$__sshs3_rc+';'+$PWD.Path+[char]7)\r`;
  }
  if (shell === "cmd") {
    const content = Buffer.from(
      "@echo off\r\n" + command.replace(/\r?\n/g, "\r\n") + "\r\n",
      "utf8",
    ).toString("base64");
    const stage = `$t=$env:TEMP; [IO.File]::WriteAllText("$t\\sshs3-${nonce}.cmd",[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${content}')),[Text.Encoding]::Default); [IO.File]::WriteAllText("$t\\sshs3-${nonce}-end.cmd",'@set "_sshs3_rc='+([char]37)+'errorlevel'+([char]37)+'"'+"\`r\`n",[Text.Encoding]::Default); [Console]::Write(([char]27)+']777;${prefix};BEGIN'+[char]7)`;
    const envelope = `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(stage, "utf16le").toString("base64")} && (call "%TEMP%\\sshs3-${nonce}.cmd" & call "%TEMP%\\sshs3-${nonce}-end.cmd" & del /q "%TEMP%\\sshs3-${nonce}.cmd" "%TEMP%\\sshs3-${nonce}-end.cmd" 2>nul & powershell -NoLogo -NoProfile -NonInteractive -Command "[Console]::Write(([char]27)+']777;${prefix};END;'+$env:_sshs3_rc+';'+$PWD.Path+[char]7)")\r`;
    if (envelope.length > 8000)
      throw new Error(
        "Command exceeds cmd's input limit. Split it into smaller approved steps.",
      );
    return envelope;
  }
  if (shell === "fish") {
    return `printf '\\033]777;${prefix};BEGIN\\007'; eval ${fishQuote(command)}; set -l __sshs3_rc $status; printf '\\033]777;${prefix};END;%s;%s\\007' $__sshs3_rc "$PWD"\r`;
  }
  return `printf '\\033]777;${prefix};BEGIN\\007'; eval ${quote(command)}; __sshs3_rc=$?; printf '\\033]777;${prefix};END;%s;%s\\007' "$__sshs3_rc" "$PWD"\r`;
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
}
function cleanInternalTitleOsc(text: string): string {
  // Strip Windows cmd.exe window-title OSC 0 sequences that leak the internal PowerShell wrapper
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /\x1b\]0;[^\x07\x1b]*(?:EncodedCommand|\]777;SSHS3;)[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    "",
  );
}
export class CommandFrames {
  private carry = "";
  private output = "";
  private displayBuffer = "";
  private started = false;
  private structuredOutput: string | undefined;
  constructor(
    private readonly nonce: string,
    private readonly maxOutput = 128_000,
    private readonly options: CommandFrameOptions = {},
  ) {}
  get commandText(): string | undefined {
    return this.options.command;
  }
  drainDisplay(): string {
    const out = this.displayBuffer;
    this.displayBuffer = "";
    return out;
  }
  feed(chunk: string): CommandResult | undefined {
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
          this.displayBuffer += `\x1b[?25h\r\x1b[2K${trailing.replace(/^(?:\r?\n)+/, "")}`;
        } else if (trailing) {
          this.displayBuffer += `\x1b[?25h${trailing}`;
        }
        return {
          output: cleanInternalTitleOsc(this.structuredOutput ?? this.output),
          exitCode: Number(parts[3]),
          cwd: parts.slice(4).join(";"),
        };
      }
    }
  }
  private append(text: string): void {
    if (this.started) {
      this.output = (this.output + text).slice(-this.maxOutput);
      if (!this.options.handshake && text) {
        this.displayBuffer += cleanInternalTitleOsc(text);
      }
    }
  }
}
