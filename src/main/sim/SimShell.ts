import { basename, dirname, normalizePath, type SimHost } from "./SimHost";
import type { SimWorld } from "./SimWorld";

/**
 * A command line for a simulated server.
 *
 * It reads a line the way a shell does as far as people and agents use one
 * at a prompt: pipes, `&&`, `||`, `;`, redirection, quotes, `sudo`, `~` and a
 * few variables. It does not run scripts: no loops, no `$( )`. What it cannot
 * do it refuses the way a real machine would, and writes down, so that what
 * agents reach for and do not find can be added.
 */

export interface SimResult {
  out: string;
  err: string;
  code: number;
}

export interface SimContext {
  host: SimHost;
  shell: SimShell;
  cwd: string;
  /** Whether the command runs as root (after `sudo`). */
  root: boolean;
  user: string;
  stdin: string;
}

/** A command answers at once, from the state: nothing in the simulation waits for anything. */
export type SimCommand = (ctx: SimContext, args: string[]) => SimResult;

export const ok = (out = ""): SimResult => ({ out, err: "", code: 0 });
export const fail = (err: string, code = 1, out = ""): SimResult => ({ out, err, code });

/** A line of text ends with a newline, as a program's output does; nothing stays nothing. */
export const lines = (list: string[]): string => (list.length ? `${list.join("\n")}\n` : "");

interface Word {
  text: string;
  /** Written in quotes: not a pattern for file names, not an operator. */
  quoted: boolean;
}
type Token = { op: string } | Word;
const isOp = (t: Token | undefined): t is { op: string } => Boolean(t && "op" in t);

const OPERATORS = ["2>&1", "&>>", "&>", "2>>", "2>", ">>", "&&", "||", ">", "<", "|", ";"];

/** What the simulation does not do, said once so every refusal reads the same. */
const NOT_A_SCRIPT = "this simulated shell runs commands and one-line for loops, not scripts: no while, if or functions. Run the commands one at a time";

function tokenize(line: string, vars: Record<string, string>): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  let word = "";
  let has = false;
  let quoted = false;
  const push = (): void => {
    if (has) tokens.push({ text: word, quoted });
    word = "";
    has = false;
    quoted = false;
  };
  const variable = (): string => {
    // At a `$`: a name the shell knows, or the sign itself.
    const rest = line.slice(i + 1);
    if (rest.startsWith("(") || rest.startsWith("{")) return "\u0000";
    if (rest.startsWith("?")) {
      i += 1;
      return vars["?"] ?? "0";
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (!name) return "$";
    i += name.length;
    return vars[name] ?? "";
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return "unexpected EOF while looking for matching `''";
      word += line.slice(i + 1, end);
      has = quoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      has = quoted = true;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && '"\\$`'.includes(line[i + 1] ?? "")) {
          word += line[i + 1];
          i += 2;
        } else if (line[i] === "$") {
          const value = variable();
          if (value === "\u0000") return NOT_A_SCRIPT;
          word += value;
          i++;
        } else if (line[i] === "`") return NOT_A_SCRIPT;
        else word += line[i++];
      }
      if (i >= line.length) return 'unexpected EOF while looking for matching `"\'';
      i++;
      continue;
    }
    if (ch === "\\") {
      word += line[i + 1] ?? "";
      has = true;
      i += 2;
      continue;
    }
    if (ch === "`") return NOT_A_SCRIPT;
    if (ch === "$") {
      const value = variable();
      if (value === "\u0000") return NOT_A_SCRIPT;
      word += value;
      has = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      push();
      i++;
      continue;
    }
    if (ch === "#" && !has) break;
    const op = OPERATORS.find((o) => line.startsWith(o, i));
    if (op) {
      push();
      tokens.push({ op });
      i += op.length;
      continue;
    }
    if (ch === "&") return "this simulated shell does not run commands in the background";
    if (ch === "~" && !has && (line[i + 1] === undefined || " /\t".includes(line[i + 1]))) {
      word += vars.HOME ?? "/root";
      has = true;
      i++;
      continue;
    }
    word += ch;
    has = true;
    i++;
  }
  push();
  return tokens;
}

/** A shell pattern (`*`, `?`, `[a-z]`) as a test for one name. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else {
        source += `[${pattern.slice(i + 1, end).replace(/\\/g, "\\\\").replace(/^!/, "^")}]`;
        i = end;
      }
    } else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- built above from a file pattern, every other character escaped
  return new RegExp(`^${source}$`);
}

interface Stage {
  argv: Word[];
  redirects: { op: string; target: string }[];
}

const SCRIPT_WORDS = new Set(["for", "while", "until", "if", "case", "function", "do", "done", "then", "fi"]);

export class SimShell {
  cwd: string;
  private lastCode = 0;
  /** Commands asked for that the simulation has no answer to: what to build next. */
  readonly unsupported: string[] = [];
  /** Every line that was run, with how it ended: what a scenario is judged on. */
  readonly history: { at: number; line: string; code: number; root: boolean }[] = [];

  constructor(
    readonly host: SimHost,
    private readonly commands: Map<string, SimCommand>,
    /** The lab this server is in: what a command that reaches another server asks. */
    readonly world?: SimWorld,
  ) {
    this.cwd = this.home();
    host.mkdir(this.cwd);
  }

  home(user = this.host.user): string {
    return user === "root" ? "/root" : `/home/${user}`;
  }

  prompt(): string {
    const where = this.cwd === this.home() ? "~" : this.cwd;
    return `${this.host.user}@${this.host.name}:${where}$ `;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Runs one line and returns what a terminal would show, errors and output together, with the exit code. */
  run(line: string): { output: string; code: number } {
    const result = this.exec(line, { root: false, stdin: "" });
    this.lastCode = result.code;
    // What follows from the new state follows now, before the next command looks.
    this.host.settle();
    this.world?.runLaws();
    this.history.push({ at: this.host.now(), line, code: result.code, root: /(^|[;&|]\s*)sudo\b/.test(line) });
    this.world?.onRan?.();
    return { output: `${result.out}${result.err}`, code: result.code };
  }

  /** A line as a command runs it: also what `sudo sh -c '…'` and `bash -c '…'` come down to. */
  exec(line: string, opts: { root: boolean; stdin: string }): SimResult {
    // for x in a b; do …; done, on one line: each round is the body with the name filled in.
    const loop = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+([^;]*?)\s*;\s*do\s+([\s\S]*?)\s*;?\s*done\s*$/.exec(line);
    if (loop) {
      const listed = this.substitute(loop[2], opts);
      if (typeof listed !== "string") return listed;
      const items = listed.split(/\s+/).filter(Boolean).flatMap((w) => (/[*?[]/.test(w) ? this.expand(w) : [w.replace(/^(["'])(.*)\1$/, "$2")]));
      const rounds: SimResult[] = items.slice(0, 200).map((item) => this.exec(loop[3].replace(new RegExp(`\\$(?:\\{${loop[1]}\\}|${loop[1]}\\b)`, "g"), item), opts));
      return { out: rounds.map((r) => r.out).join(""), err: rounds.map((r) => r.err).join(""), code: rounds.length ? rounds[rounds.length - 1].code : 0 };
    }
    const filled = this.substitute(line, opts);
    if (typeof filled !== "string") return filled;
    line = filled;
    const tokens = tokenize(line, {
      "?": String(this.lastCode),
      HOME: this.home(),
      USER: opts.root ? "root" : this.host.user,
      PWD: this.cwd,
      HOSTNAME: this.host.name,
    });
    if (typeof tokens === "string") return fail(`bash: ${tokens}\n`, 2);
    if (!tokens.length) return ok();
    // Lists: a; b && c || d. Each part is a pipeline.
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    let start = 0;
    let run = true;
    for (let i = 0; i <= tokens.length; i++) {
      const t = tokens[i];
      const end = i === tokens.length || (isOp(t) && [";", "&&", "||"].includes(t.op));
      if (!end) continue;
      const part = tokens.slice(start, i);
      if (run && part.length) {
        const result = this.pipeline(part, opts);
        out.push(result.out);
        err.push(result.err);
        code = result.code;
        this.lastCode = code;
      } else if (!part.length && i < tokens.length) return fail(`bash: syntax error near unexpected token \`${(t as { op: string }).op}'\n`, 2);
      if (isOp(t)) run = t.op === ";" ? true : t.op === "&&" ? code === 0 : code !== 0;
      start = i + 1;
    }
    return { out: out.join(""), err: err.join(""), code };
  }

  /**
   * `$(command)` and backticks: the command's output in its place, as the
   * shell does before it reads the line. Not inside single quotes.
   */
  private substitute(line: string, opts: { root: boolean; stdin: string }, depth = 0): string | SimResult {
    if (!line.includes("$(") && !line.includes("`")) return line;
    if (depth > 8) return fail("bash: command substitution: too deep\n", 2);
    let out = "";
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote === "'") {
        out += ch;
        if (ch === "'") quote = "";
        continue;
      }
      if (ch === "\\") {
        out += ch + (line[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === "'" && !quote) quote = "'";
      else if (ch === '"') quote = quote ? "" : '"';
      let inner: string | undefined;
      let end = -1;
      if (ch === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
        let level = 0;
        for (let j = i + 1; j < line.length; j++) {
          if (line[j] === "(") level++;
          else if (line[j] === ")" && --level === 0) {
            end = j;
            break;
          }
        }
        if (end < 0) return fail("bash: unexpected EOF while looking for matching `)'\n", 2);
        inner = line.slice(i + 2, end);
      } else if (ch === "`") {
        end = line.indexOf("`", i + 1);
        if (end < 0) return fail("bash: unexpected EOF while looking for matching ``'\n", 2);
        inner = line.slice(i + 1, end);
      }
      if (inner === undefined) {
        out += ch;
        continue;
      }
      const ran = this.exec(inner, { root: opts.root, stdin: "" });
      const text = ran.out.replace(/\n+$/, "");
      // Inside double quotes it stays one word as it is; outside, its lines become words. Quotes in it are text.
      out += (quote === '"' ? text : text.replace(/\s+/g, " ")).replace(/[\\"'$`]/g, "\\$&");
      i = end;
    }
    return out;
  }

  private pipeline(tokens: Token[], opts: { root: boolean; stdin: string }): SimResult {
    const stages: Stage[] = [{ argv: [], redirects: [] }];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const stage = stages[stages.length - 1];
      if (!isOp(t)) {
        stage.argv.push(t);
        continue;
      }
      if (t.op === "|") {
        if (!stage.argv.length && !stage.redirects.length) return fail("bash: syntax error near unexpected token `|'\n", 2);
        stages.push({ argv: [], redirects: [] });
        continue;
      }
      if (t.op === "2>&1") {
        stage.redirects.push({ op: t.op, target: "" });
        continue;
      }
      const target = tokens[++i];
      if (!target || isOp(target)) return fail("bash: syntax error near unexpected token `newline'\n", 2);
      stage.redirects.push({ op: t.op, target: target.text });
    }
    if (!stages[stages.length - 1].argv.length && !stages[stages.length - 1].redirects.length) return fail("bash: syntax error near unexpected token `|'\n", 2);
    let stdin = opts.stdin;
    let last: SimResult = ok();
    const errors: string[] = [];
    for (const stage of stages) {
      last = this.stage(stage, { root: opts.root, stdin });
      stdin = last.out;
      errors.push(last.err);
    }
    return { out: last.out, err: errors.join(""), code: last.code };
  }

  private stage(stage: Stage, opts: { root: boolean; stdin: string }): SimResult {
    let stdin = opts.stdin;
    for (const r of stage.redirects.filter((x) => x.op === "<")) {
      // `</dev/null`: nothing to read, as on any machine. (It came back "No such file or directory".)
      if (r.target === "/dev/null") {
        stdin = "";
        continue;
      }
      const file = this.host.read(normalizePath(r.target, this.cwd));
      if (!file) return fail(`bash: ${r.target}: No such file or directory\n`, 1);
      if (!this.mayRead(r.target, opts.root)) return fail(`bash: ${r.target}: Permission denied\n`, 1);
      stdin = file.content;
    }
    // Names with a pattern become the files they match; one that matches nothing stays as it was typed.
    const argv: string[] = [];
    for (const w of stage.argv) {
      if (w.quoted || !/[*?[]/.test(w.text)) {
        argv.push(w.text);
        continue;
      }
      const matches = this.expand(w.text);
      argv.push(...(matches.length ? matches : [w.text]));
    }
    let result = this.dispatch(argv, { root: opts.root, stdin });
    for (const r of stage.redirects) {
      if (r.op === "<") continue;
      if (r.op === "2>&1") {
        result = { out: `${result.out}${result.err}`, err: "", code: result.code };
        continue;
      }
      const both = r.op.startsWith("&");
      const errOnly = r.op.startsWith("2");
      const text = both ? `${result.out}${result.err}` : errOnly ? result.err : result.out;
      if (r.target !== "/dev/null") {
        const wrote = this.writeFile(r.target, text, r.op.endsWith(">>"), opts.root);
        if (wrote) return fail(`bash: ${r.target}: ${wrote}\n`, 1);
      }
      result = { out: both || !errOnly ? "" : result.out, err: both || errOnly ? "" : result.err, code: result.code };
    }
    return result;
  }

  /** The files a pattern names, from where the shell stands. */
  expand(pattern: string): string[] {
    const absolute = pattern.startsWith("/");
    const parts = normalizePath(pattern, this.cwd).split("/").filter(Boolean);
    let found = ["/"];
    for (const part of parts) {
      const next: string[] = [];
      for (const dir of found) {
        if (!/[*?[]/.test(part)) {
          const path = normalizePath(part, dir);
          if (this.host.exists(path)) next.push(path);
          continue;
        }
        const test = globToRegExp(part);
        for (const entry of this.host.list(dir)) if (test.test(entry.name) && (part.startsWith(".") || !entry.name.startsWith("."))) next.push(normalizePath(entry.name, dir));
      }
      found = next;
    }
    if (absolute) return found;
    const prefix = this.cwd === "/" ? "/" : `${this.cwd}/`;
    return found.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
  }

  /** Whether this user may write where `path` is. Their own folder and the temporary ones; the rest is root's. */
  mayWrite(path: string, root: boolean): boolean {
    if (root) return true;
    const p = normalizePath(path, this.cwd);
    const file = this.host.read(p);
    if (file) return file.owner === this.host.user;
    return p.startsWith(`${this.home()}/`) || p === this.home() || p.startsWith("/tmp/") || p.startsWith("/var/tmp/");
  }

  /** Whether this user may read a file: world-readable, or their own. */
  mayRead(path: string, root: boolean): boolean {
    if (root) return true;
    const file = this.host.read(normalizePath(path, this.cwd));
    return !file || file.owner === this.host.user || (file.mode & 0o004) !== 0;
  }

  /** Writes a file as a command or a redirection would. Returns what went wrong, in the system's words. */
  writeFile(path: string, text: string, append: boolean, root: boolean): string | undefined {
    const p = normalizePath(path, this.cwd);
    if (this.host.isDir(p)) return "Is a directory";
    if (!this.host.isDir(dirname(p))) return "No such file or directory";
    if (!this.mayWrite(p, root)) return "Permission denied";
    const had = this.host.read(p);
    const next = append ? `${had?.content ?? ""}${text}` : text;
    // A file written anew gives back all it held, its bulk too; one added to keeps it.
    const grows = Buffer.byteLength(next, "utf8") - (had ? (append ? Buffer.byteLength(had.content, "utf8") : this.host.sizeOf(had)) : 0);
    if (grows > 0 && !this.host.hasRoomFor(p, grows)) return "No space left on device";
    this.host.write(p, next, { pad: append ? had?.pad : 0, owner: had?.owner ?? (root ? "root" : this.host.user) });
    return undefined;
  }

  private dispatch(argv: string[], opts: { root: boolean; stdin: string }): SimResult {
    // VAR=value in front of a command: taken, and not acted on.
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
    if (!argv.length) return ok();
    const name = argv[0];
    // The shell's own no-op: what a connection is tested with.
    if (name === ":") return ok();
    const ctx: SimContext = { host: this.host, shell: this, cwd: this.cwd, root: opts.root, user: opts.root ? "root" : this.host.user, stdin: opts.stdin };
    if (SCRIPT_WORDS.has(name)) {
      this.unsupported.push(argv.join(" "));
      return fail(`bash: ${NOT_A_SCRIPT}\n`, 2);
    }
    if (name === "sudo") {
      const rest = argv.slice(1);
      // -u someone: still more than this user may do by themselves, and close enough to root for what is simulated.
      while (rest[0]?.startsWith("-")) {
        const flag = rest.shift()!;
        if (flag === "-u" || flag === "-g") rest.shift();
        if (flag === "-l") return ok(lines([`User ${this.host.user} may run the following commands on ${this.host.name}:`, "    (ALL : ALL) NOPASSWD: ALL"]));
      }
      if (!rest.length) return fail("usage: sudo [-u user] command\n", 1);
      return this.dispatch(rest, { root: true, stdin: opts.stdin });
    }
    // `timeout 8 command`: nothing here waits, so no command runs out of time. The command is what counts.
    if (name === "timeout") {
      const rest = argv.slice(1);
      while (rest[0]?.startsWith("-")) {
        const flag = rest.shift()!;
        if (flag === "-s" || flag === "-k") rest.shift();
      }
      rest.shift();
      if (!rest.length) return fail("timeout: missing operand\nTry 'timeout --help' for more information.\n", 125);
      return this.dispatch(rest, opts);
    }
    if ((name === "sh" || name === "bash") && argv[1] === "-c") return argv[2] === undefined ? fail(`${name}: -c: option requires an argument\n`, 2) : this.exec(argv[2], opts);
    if (name === "cd") {
      const target = normalizePath(argv[1] ?? this.home(), this.cwd);
      if (this.host.read(target)) return fail(`bash: cd: ${argv[1]}: Not a directory\n`, 1);
      if (!this.host.isDir(target)) return fail(`bash: cd: ${argv[1]}: No such file or directory\n`, 1);
      this.cwd = target;
      return ok();
    }
    if (this.host.only && !this.host.only.commands.has(name)) {
      this.unsupported.push(argv.join(" "));
      return fail(`${this.host.only.unknown(name)}\n`, 1);
    }
    if (name.includes("/") || ((name === "sh" || name === "bash") && argv[1] && !argv[1].startsWith("-"))) {
      const viaShell = !name.includes("/");
      const path = normalizePath(viaShell ? argv[1] : name, this.cwd);
      const file = this.host.read(path);
      const program = this.host.programs.get(path) as SimCommand | undefined;
      if (file && !viaShell && !(file.mode & 0o111)) return fail(`bash: ${name}: Permission denied\n`, 126);
      if (file && !this.mayRead(path, opts.root)) return fail(`bash: ${viaShell ? argv[1] : name}: Permission denied\n`, 126);
      if (program && file) {
        try {
          return program(ctx, argv.slice(viaShell ? 2 : 1));
        } catch (error) {
          this.unsupported.push(argv.join(" "));
          return fail(`${name}: ${error instanceof Error ? error.message : String(error)}\n`, 2);
        }
      }
      if (file || viaShell) {
        this.unsupported.push(argv.join(" "));
        return file ? fail(`bash: ${viaShell ? argv[1] : name}: running this script is not part of this simulation (read it with cat, and run what it runs)\n`, 126) : fail(`${name}: ${argv[1]}: No such file or directory\n`, 127);
      }
      // A program named by its path is one of the system's own only where those live.
      if (!this.commands.has(basename(name)) || !/^\/(usr\/(local\/)?)?s?bin$/.test(dirname(path))) return fail(`bash: ${name}: No such file or directory\n`, 127);
    }
    const command = this.commands.get(name.includes("/") ? basename(name) : name);
    if (!command) {
      this.unsupported.push(argv.join(" "));
      return fail(`bash: ${name}: command not found\n`, 127);
    }
    try {
      return command(ctx, argv.slice(1));
    } catch (error) {
      // A command that was asked something it has no answer for: said plainly, and written down.
      this.unsupported.push(argv.join(" "));
      return fail(`${name}: ${error instanceof Error ? error.message : String(error)}\n`, 2, error instanceof NotSimulated ? error.output : "");
    }
  }
}

/** For a command to say it does not do what was asked: the shell answers with it and notes the line. */
export class NotSimulated extends Error {
  /** Output already printed before an unsupported operation stopped the command. */
  output = "";
  constructor(what: string) {
    super(`${what} is not part of this simulation`);
  }
}

/** Options and operands of a command line, the usual way: `-abc`, `-n 5`, `--long`, `--key=value`, `--` ends options. */
export function parseArgs(
  args: string[],
  takesValue: string[] = [],
  onValue?: (key: string, value: string) => void,
): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const setValue = (key: string, value: string): void => {
    values.set(key, value);
    onValue?.(key, value);
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) setValue(key, a.slice(eq + 1));
      else if (takesValue.includes(key) && i + 1 < args.length) setValue(key, args[++i]);
      else flags.add(key);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const key = a[j];
        if (takesValue.includes(key)) {
          const value = a.slice(j + 1) || args[++i];
          if (value !== undefined) setValue(key, value);
          break;
        }
        flags.add(key);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, values, rest };
}
