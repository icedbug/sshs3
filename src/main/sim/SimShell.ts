import { basename, dirname, normalizePath, type SimHost } from "./SimHost";
import type { SimWorld } from "./SimWorld";

/**
 * A command line for a simulated server.
 *
 * It reads a line the way a shell does as far as people and agents use one
 * at a prompt: pipes, `&&`, `||`, `;`, several lines, redirection, quotes,
 * `sudo`, `~`, variables, `$( )`, a group in `( )` or `{ }`, `case`, `if` and
 * `for`. It is not a whole shell: no `while`, no functions, no here-documents,
 * nothing in the background. A line that needs one of those is not run at
 * all, not even its first half: the shell says which construct it cannot run,
 * and writes it down, so that what agents reach for and do not find can be
 * added.
 */

export interface SimResult {
  out: string;
  err: string;
  code: number;
  /** Set by `exit`: what follows on the line is not run. The shell takes it off before it answers. */
  exit?: boolean;
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

/**
 * A line that was not run: one bash would refuse too (`syntax`), or one that needs something this
 * shell does not do (`cannot`, with the construct as its message).
 */
class ParseStop extends Error {
  constructor(
    readonly kind: "syntax" | "cannot",
    message: string,
  ) {
    super(message);
  }
}
const unexpected = (token: string): ParseStop => new ParseStop("syntax", `syntax error near unexpected token \`${token === "\n" ? "newline" : token}'`);
const unclosed = (mark: string): ParseStop => new ParseStop("syntax", `unexpected EOF while looking for matching \`${mark}'`);
const cannot = (what: string): ParseStop => new ParseStop("cannot", what);

/** What the caller reads when a line needs something this shell does not do. One wording for every case. */
export const cannotRun = (what: string): string => `sim: this lab's shell cannot run: ${what}\n`;

// ---- Reading a line: where a quote, a `$( )` or a word ends --------------------------------------

/** The place after the double quote that closes the one at `at`. */
function afterDoubleQuote(src: string, at: number): number {
  let i = at + 1;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "`") i = afterBackticks(src, i);
    else if (src[i] === "$" && src[i + 1] === "(") i = afterSubstitution(src, i);
    else if (src[i] === "$" && src[i + 1] === "{") i = afterBraces(src, i);
    else i++;
  }
  if (i >= src.length) throw unclosed('"');
  return i + 1;
}

/** `$( … )` at `at`: the place after its closing parenthesis. What is inside has to be a line this shell can run. */
function afterSubstitution(src: string, at: number): number {
  if (src[at + 2] === "(") throw cannot("arithmetic in $(( ))");
  let depth = 1;
  let i = at + 2;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw unclosed("'");
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = afterDoubleQuote(src, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
    i++;
  }
  if (i >= src.length) throw unclosed(")");
  parseScript(src.slice(at + 2, i));
  return i + 1;
}

/** Backticks at `at`: the place after the closing one. */
function afterBackticks(src: string, at: number): number {
  const end = src.indexOf("`", at + 1);
  if (end < 0) throw unclosed("`");
  parseScript(src.slice(at + 1, end));
  return end + 1;
}

/** `${name}` at `at`: the place after it. The plain form is the one this shell knows. */
function afterBraces(src: string, at: number): number {
  const end = src.indexOf("}", at + 2);
  if (end < 0) throw unclosed("}");
  const inner = src.slice(at + 2, end);
  if (!/^([A-Za-z_]\w*|\?)$/.test(inner)) throw cannot(`the expansion \${${inner}}`);
  return end + 1;
}

/** Where the word that starts at `from` ends: at a blank or an operator that is not in quotes. */
function afterWord(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (" \t\r\n;|()".includes(ch)) break;
    if (ch === "&") {
      // `&>` and `2>&1` send output somewhere. Any other `&` is not part of a word.
      if (src[i + 1] === ">" || (i > from && "<>".includes(src[i - 1]))) {
        i++;
        continue;
      }
      break;
    }
    if (ch === "\\") {
      if (src[i + 1] === "\n") break;
      i += 2;
    } else if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw unclosed("'");
      i = end + 1;
    } else if (ch === '"') i = afterDoubleQuote(src, i);
    else if (ch === "`") i = afterBackticks(src, i);
    else if (ch === "$" && src[i + 1] === "(") i = afterSubstitution(src, i);
    else if (ch === "$" && src[i + 1] === "{") i = afterBraces(src, i);
    else if (ch === "<" && src[i + 1] === "<") throw cannot("a here-document (<<)");
    else if ((ch === "<" || ch === ">") && src[i + 1] === "(") throw cannot("process substitution, <( ) or >( )");
    else i++;
  }
  return Math.min(i, src.length);
}

/** A piece of a line as it is written: an operator between commands, or a word with its quotes still on. */
type Piece = { op: string } | { word: string; at: number; end: number };
const isWordPiece = (p: Piece | undefined): p is { word: string; at: number; end: number } => Boolean(p && "word" in p);

function pieces(src: string): Piece[] {
  const list: Piece[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\r") i++;
    // A backslash at the end of a line joins it to the next one.
    else if (ch === "\\" && src[i + 1] === "\n") i += 2;
    else if (ch === "\n") {
      list.push({ op: "\n" });
      i++;
    } else if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("&&", i) || src.startsWith("||", i) || src.startsWith(";;", i)) {
      list.push({ op: src.slice(i, i + 2) });
      i += 2;
    } else if (src.startsWith("|&", i)) throw cannot("a pipe that carries errors too (|&)");
    else if (ch === ";" || ch === "(" || ch === ")" || ch === "|") {
      list.push({ op: ch });
      i++;
    } else if (ch === "&" && src[i + 1] !== ">") throw cannot("a command in the background (&)");
    else {
      const at = i;
      i = afterWord(src, i);
      list.push({ word: src.slice(at, i), at, end: i });
    }
  }
  return list;
}

// ---- What a line is made of ------------------------------------------------------------------------

/**
 * A line, read. A plain command keeps its text as it was written: its variables and `$( )` are filled
 * in when its turn comes, so `x=$(a) && echo "$x"` sees what `a` printed.
 */
type Node =
  | { kind: "simple"; text: string }
  | { kind: "pipe"; stages: Node[]; not: boolean }
  | { kind: "list"; items: { op: ";" | "&&" | "||"; node: Node }[] }
  | { kind: "sub" | "group"; body: Node; redirects: string }
  | { kind: "case"; word: string; arms: { patterns: string[]; body: Node }[]; redirects: string }
  | { kind: "for"; name: string; items: string; body: Node; redirects: string }
  | { kind: "if"; branches: { test: Node; then: Node }[]; otherwise?: Node; redirects: string };

/** How deep groups and `$( )` may sit inside each other: enough for any real line, and a stop for a runaway one. */
const DEEPEST = 40;

class Parser {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly list: Piece[],
  ) {}

  private peek(): Piece | undefined {
    return this.list[this.i];
  }
  private isOp(op: string): boolean {
    const p = this.peek();
    return Boolean(p && "op" in p && p.op === op);
  }
  private isWord(word: string): boolean {
    const p = this.peek();
    return isWordPiece(p) && p.word === word;
  }
  private say(p: Piece | undefined): ParseStop {
    return p ? unexpected("op" in p ? p.op : p.word) : new ParseStop("syntax", "syntax error: unexpected end of file");
  }
  private newlines(): void {
    while (this.isOp("\n")) this.i++;
  }
  private expectWord(word: string): void {
    if (!this.isWord(word)) throw this.say(this.peek());
    this.i++;
  }

  script(): Node {
    const body = this.commands([]);
    if (this.peek()) throw this.say(this.peek());
    return body;
  }

  /** Commands one after another, up to `)`, `;;`, the end, or one of the words in `until` where a command would start. */
  private commands(until: string[]): Node & { kind: "list" } {
    const items: { op: ";" | "&&" | "||"; node: Node }[] = [];
    const atEnd = (): boolean => {
      const p = this.peek();
      return !p || ("op" in p ? p.op === ")" || p.op === ";;" : until.includes(p.word));
    };
    this.newlines();
    while (!atEnd()) {
      items.push({ op: ";", node: this.pipeline() });
      while (this.isOp("&&") || this.isOp("||")) {
        const op = (this.peek() as { op: "&&" | "||" }).op;
        this.i++;
        this.newlines();
        // `a &&` with nothing after it: a real shell waits for the rest. Here `a` is what there is.
        if (!this.peek()) break;
        items.push({ op, node: this.pipeline() });
      }
      if (this.isOp(";")) this.i++;
      else if (!this.isOp("\n")) break;
      this.newlines();
    }
    return { kind: "list", items };
  }

  private pipeline(): Node {
    let not = false;
    while (this.isWord("!")) {
      not = !not;
      this.i++;
    }
    const stages = [this.command()];
    while (this.isOp("|")) {
      this.i++;
      this.newlines();
      if (!this.peek()) throw unexpected("|");
      stages.push(this.command());
    }
    return stages.length === 1 && !not ? stages[0] : { kind: "pipe", stages, not };
  }

  /** What may follow a group: where its output goes. Kept as written, read when the group runs. */
  private redirects(): string {
    const first = this.peek();
    if (!isWordPiece(first)) return "";
    if (!/^(\d?[<>]|&>)/.test(first.word)) throw unexpected(first.word);
    let end = first.end;
    while (isWordPiece(this.peek())) end = (this.list[this.i++] as { end: number }).end;
    return this.src.slice(first.at, end);
  }

  private body(until: string[], closer: string): Node {
    const inner = this.commands(until);
    if (!inner.items.length) throw this.say(this.peek() ?? { op: closer });
    return inner;
  }

  private command(): Node {
    if (++this.depth > DEEPEST) throw new ParseStop("syntax", "this line is nested too deep");
    try {
      return this.oneCommand();
    } finally {
      this.depth--;
    }
  }

  private oneCommand(): Node {
    const p = this.peek();
    if (!p) throw this.say(p);
    if ("op" in p) {
      if (p.op !== "(") throw this.say(p);
      this.i++;
      const body = this.body([], ")");
      if (!this.isOp(")")) throw this.say(this.peek());
      this.i++;
      return { kind: "sub", body, redirects: this.redirects() };
    }
    switch (p.word) {
      case "{": {
        this.i++;
        const body = this.body(["}"], "}");
        this.expectWord("}");
        return { kind: "group", body, redirects: this.redirects() };
      }
      case "case":
        return this.caseOf();
      case "for":
        return this.forLoop();
      case "if":
        return this.ifThen();
      case "while":
        throw cannot("a while loop");
      case "until":
        throw cannot("an until loop");
      case "select":
        throw cannot("a select menu");
      case "function":
        throw cannot("a function");
      case "}":
      case "esac":
      case "do":
      case "done":
      case "then":
      case "elif":
      case "else":
      case "fi":
        throw this.say(p);
    }
    // A plain command: its words and where its output goes, up to the next operator.
    let end = p.end;
    while (isWordPiece(this.peek())) end = (this.list[this.i++] as { end: number }).end;
    if (this.isOp("(")) {
      const next = this.list[this.i + 1];
      throw next && "op" in next && next.op === ")" ? cannot("a function") : unexpected("(");
    }
    return { kind: "simple", text: this.src.slice(p.at, end) };
  }

  private caseOf(): Node {
    this.i++;
    const word = this.peek();
    if (!isWordPiece(word)) throw this.say(word);
    this.i++;
    this.newlines();
    this.expectWord("in");
    this.newlines();
    const arms: { patterns: string[]; body: Node }[] = [];
    while (!this.isWord("esac")) {
      if (this.isOp("(")) this.i++;
      const patterns: string[] = [];
      for (;;) {
        const pattern = this.peek();
        if (!isWordPiece(pattern)) throw this.say(pattern);
        patterns.push(pattern.word);
        this.i++;
        if (!this.isOp("|")) break;
        this.i++;
      }
      if (!this.isOp(")")) throw this.say(this.peek());
      this.i++;
      arms.push({ patterns, body: this.commands(["esac"]) });
      if (this.isOp(";;")) this.i++;
      else if (!this.isWord("esac")) throw this.say(this.peek());
      this.newlines();
    }
    this.i++;
    return { kind: "case", word: word.word, arms, redirects: this.redirects() };
  }

  private forLoop(): Node {
    this.i++;
    if (this.isOp("(")) throw cannot("a counting for loop, for (( ))");
    const name = this.peek();
    if (!isWordPiece(name) || !/^[A-Za-z_]\w*$/.test(name.word)) throw this.say(name);
    this.i++;
    this.newlines();
    if (!this.isWord("in")) throw cannot("a for loop without a list after `in`");
    this.i++;
    let items = "";
    const first = this.peek();
    if (isWordPiece(first)) {
      let end = first.end;
      while (isWordPiece(this.peek())) end = (this.list[this.i++] as { end: number }).end;
      items = this.src.slice(first.at, end);
    }
    if (this.isOp(";")) this.i++;
    this.newlines();
    this.expectWord("do");
    const body = this.body(["done"], "done");
    this.expectWord("done");
    return { kind: "for", name: name.word, items, body, redirects: this.redirects() };
  }

  private ifThen(): Node {
    const branches: { test: Node; then: Node }[] = [];
    let otherwise: Node | undefined;
    do {
      this.i++;
      const test = this.body(["then"], "then");
      this.expectWord("then");
      branches.push({ test, then: this.body(["elif", "else", "fi"], "fi") });
    } while (this.isWord("elif"));
    if (this.isWord("else")) {
      this.i++;
      otherwise = this.body(["fi"], "fi");
    }
    this.expectWord("fi");
    return { kind: "if", branches, otherwise, redirects: this.redirects() };
  }
}

let nesting = 0;

/** Reads a line. Throws a `ParseStop` for one that is not run. */
function parseScript(src: string): Node {
  if (++nesting > DEEPEST) {
    nesting = 0;
    throw new ParseStop("syntax", "command substitution: too deep");
  }
  try {
    return new Parser(src, pieces(src)).script();
  } finally {
    nesting = Math.max(0, nesting - 1);
  }
}

// ---- A command's words -----------------------------------------------------------------------------

interface Word {
  text: string;
  /** Written in quotes: not a pattern for file names, not an operator. */
  quoted: boolean;
  /** `name=value` with the name written plainly: by itself it sets a variable. */
  assign?: boolean;
}
type Token = { op: string } | Word;
const isOp = (t: Token | undefined): t is { op: string } => Boolean(t && "op" in t);

/** Where output and input go. Longest first; the ones with a digit in front count only where a word starts. */
const REDIRECTS = ["2>&1", "1>&2", "&>>", "2>>", "1>>", ">&2", "&>", "2>", "1>", ">>", ">", "<"];
const SAME_AS: Record<string, string> = { "1>&2": ">&2", "1>>": ">>", "1>": ">" };

/** What a word's `$name` and `$( )` stand for when the command's turn comes. */
interface Filling {
  value(name: string): string | undefined;
  /** Runs what is inside `$( )` and gives what it printed, the newlines at its end gone. */
  run(script: string): string;
}

/** Splits one command into its words and redirections, quotes taken off and variables filled in. */
function tokenize(line: string, fill: Filling): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let word = "";
  let has = false;
  let quoted = false;
  let assign = false;
  const push = (): void => {
    if (has) tokens.push(assign ? { text: word, quoted, assign } : { text: word, quoted });
    word = "";
    has = false;
    quoted = false;
    assign = false;
  };
  /** At a `$` or a backtick: what it stands for, with `i` left on its last character. Nothing when the sign is only itself. */
  const filled = (): string | undefined => {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      const text = fill.run(line.slice(i + 1, end));
      i = end;
      return text;
    }
    const rest = line.slice(i + 1);
    if (rest.startsWith("(")) {
      const end = afterSubstitution(line, i);
      const text = fill.run(line.slice(i + 2, end - 1));
      i = end - 1;
      return text;
    }
    if (rest.startsWith("{")) {
      const end = afterBraces(line, i);
      const name = line.slice(i + 2, end - 1);
      i = end - 1;
      return fill.value(name) ?? "";
    }
    if (rest.startsWith("?")) {
      i += 1;
      return fill.value("?") ?? "0";
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (!name) return undefined;
    i += name.length;
    return fill.value(name) ?? "";
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw unclosed("'");
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
        } else if (line[i] === "$" || line[i] === "`") {
          word += filled() ?? "$";
          i++;
        } else word += line[i++];
      }
      if (i >= line.length) throw unclosed('"');
      i++;
      continue;
    }
    if (ch === "\\") {
      if (line[i + 1] === "\n") push();
      else {
        word += line[i + 1] ?? "";
        has = true;
      }
      i += 2;
      continue;
    }
    if (ch === "$" || ch === "`") {
      const value = filled();
      if (value === undefined) {
        word += "$";
        has = true;
      } else if (assign) {
        // The value of `name=…` is one word, whatever is in it.
        word += value;
      } else {
        // Outside quotes what it gives is split into words, as a shell does. Nothing gives no word.
        value.split(/\s+/).forEach((part, n) => {
          if (n) push();
          if (part) {
            word += part;
            has = true;
          }
        });
      }
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push();
      i++;
      continue;
    }
    const op = REDIRECTS.find((o) => line.startsWith(o, i) && (has ? !/^\d/.test(o) : true));
    if (op) {
      push();
      tokens.push({ op: SAME_AS[op] ?? op });
      i += op.length;
      continue;
    }
    if (ch === "&") throw unexpected("&");
    if (ch === "~" && !has && (line[i + 1] === undefined || " /\t".includes(line[i + 1]))) {
      word += fill.value("HOME") ?? "/root";
      has = true;
      i++;
      continue;
    }
    if (ch === "=" && has && !quoted && !assign && /^[A-Za-z_]\w*$/.test(word)) assign = true;
    word += ch;
    has = true;
    i++;
  }
  push();
  return tokens;
}

/** A shell pattern (`*`, `?`, `[a-z]`) as a test for one name. With `whole`, `*` and `?` also match a `/`: a `case` pattern is held against any text. */
export function globToRegExp(pattern: string, whole = false): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += whole ? "[\\s\\S]*" : "[^/]*";
    else if (c === "?") source += whole ? "[\\s\\S]" : "[^/]";
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

interface Redirect {
  op: string;
  target: string;
}
interface Stage {
  argv: Word[];
  redirects: Redirect[];
}
interface RunOptions {
  root: boolean;
  stdin: string;
}

/** A command's words apart from where its input and output go. */
function splitRedirects(tokens: Token[]): Stage {
  const stage: Stage = { argv: [], redirects: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isOp(t)) {
      stage.argv.push(t);
      continue;
    }
    if (t.op === "2>&1" || t.op === ">&2") {
      stage.redirects.push({ op: t.op, target: "" });
      continue;
    }
    const target = tokens[++i];
    if (!target || isOp(target)) throw unexpected("\n");
    stage.redirects.push({ op: t.op, target: target.text });
  }
  return stage;
}

export class SimShell {
  cwd: string;
  private lastCode = 0;
  /** What was set with `name=value` or `export`: kept for as long as the shell is open, as the folder is. */
  private vars = new Map<string, string>();
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
    this.history.push({ at: this.host.now(), line, code: result.code, root: /(^|[;&|({\n]\s*)sudo\b/.test(line) });
    this.world?.onRan?.();
    return { output: `${result.out}${result.err}`, code: result.code };
  }

  /**
   * A line as a command runs it: also what `sudo sh -c '…'` and `bash -c '…'` come down to. The whole
   * line is read first. One that cannot be read, or that needs something this shell does not do, is
   * refused before any of it runs: half a rollback is worse than none.
   */
  exec(line: string, opts: RunOptions): SimResult {
    let script: Node;
    try {
      script = parseScript(line);
    } catch (error) {
      if (error instanceof ParseStop) return this.refused(error);
      throw error;
    }
    const { out, err, code } = this.runNode(script, opts);
    return { out, err, code };
  }

  private refused(stop: ParseStop): SimResult {
    if (stop.kind === "syntax") return fail(`bash: ${stop.message}\n`, 2);
    this.unsupported.push(stop.message);
    return fail(cannotRun(stop.message), 2);
  }

  private runNode(node: Node, opts: RunOptions): SimResult {
    try {
      return this.runKind(node, opts);
    } catch (error) {
      if (error instanceof ParseStop) return this.refused(error);
      throw error;
    }
  }

  private runKind(node: Node, opts: RunOptions): SimResult {
    switch (node.kind) {
      case "simple":
        return this.simple(node.text, opts);
      case "list":
        return this.sequence(
          node.items.map((item) => ({ when: item.op, run: () => this.runNode(item.node, opts) })),
        );
      case "pipe":
        return this.pipe(node.stages, node.not, opts);
      case "sub":
        return this.redirected(node.redirects, opts, (o) => this.apart(() => this.runNode(node.body, o)));
      case "group":
        return this.redirected(node.redirects, opts, (o) => this.runNode(node.body, o));
      case "case":
        return this.redirected(node.redirects, opts, (o) => {
          const word = this.words(node.word, o).map((w) => w.text).join(" ");
          for (const arm of node.arms) {
            for (const pattern of arm.patterns) {
              const written = this.words(pattern, o);
              const text = written.map((w) => w.text).join(" ");
              // A pattern in quotes is the text itself; one written plainly may hold `*`, `?` and `[…]`.
              const matches = written.length > 0 && written.every((w) => w.quoted) ? text === word : globToRegExp(text, true).test(word);
              if (matches) return this.runNode(arm.body, o);
            }
          }
          return ok();
        });
      case "for":
        return this.redirected(node.redirects, opts, (o) => {
          const items = this.words(node.items, o).flatMap((w) => {
            if (w.quoted || !/[*?[]/.test(w.text)) return [w.text];
            const found = this.expand(w.text);
            return found.length ? found : [w.text];
          });
          // Each round is the body with the name set. 200 rounds is more than a person's loop, and an end to any other.
          return this.sequence(
            items.slice(0, 200).map((item) => ({
              when: ";" as const,
              run: () => {
                this.vars.set(node.name, item);
                return this.runNode(node.body, o);
              },
            })),
          );
        });
      case "if":
        return this.redirected(node.redirects, opts, (o) => {
          const said: SimResult[] = [];
          const after = (last: SimResult): SimResult => ({ ...last, out: `${said.map((r) => r.out).join("")}${last.out}`, err: `${said.map((r) => r.err).join("")}${last.err}` });
          for (const branch of node.branches) {
            const test = this.runNode(branch.test, o);
            if (test.exit) return after(test);
            said.push(test);
            if (test.code === 0) return after(this.runNode(branch.then, o));
          }
          return after(node.otherwise ? this.runNode(node.otherwise, o) : ok());
        });
    }
  }

  /** Runs parts one after another: `;` always, `&&` after one that went well, `||` after one that did not. `exit` ends it. */
  private sequence(parts: { when: ";" | "&&" | "||"; run: () => SimResult }[]): SimResult {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    for (const part of parts) {
      if (part.when === "&&" ? code !== 0 : part.when === "||" ? code === 0 : false) continue;
      const result = part.run();
      out.push(result.out);
      err.push(result.err);
      code = result.code;
      this.lastCode = code;
      if (result.exit) return { out: out.join(""), err: err.join(""), code, exit: true };
    }
    return { out: out.join(""), err: err.join(""), code };
  }

  private pipe(stages: Node[], not: boolean, opts: RunOptions): SimResult {
    let stdin = opts.stdin;
    let last: SimResult = ok();
    const errors: string[] = [];
    for (const stage of stages) {
      const ran = this.runNode(stage, { root: opts.root, stdin });
      // Each part of a pipe is a shell of its own: `exit` in it ends that part only.
      last = stages.length > 1 ? { out: ran.out, err: ran.err, code: ran.code } : ran;
      stdin = last.out;
      errors.push(last.err);
    }
    return { ...last, err: errors.join(""), code: not ? (last.code === 0 ? 1 : 0) : last.code };
  }

  /** Runs something as a shell of its own would: the folder and the variables it changes are its own, and `exit` ends only it. */
  private apart(run: () => SimResult): SimResult {
    const cwd = this.cwd;
    const vars = new Map(this.vars);
    try {
      const { out, err, code } = run();
      return { out, err, code };
    } finally {
      this.cwd = cwd;
      this.vars = vars;
    }
  }

  private variable(name: string, root: boolean): string | undefined {
    if (name === "?") return String(this.lastCode);
    if (name === "PWD") return this.cwd;
    const set = this.vars.get(name);
    if (set !== undefined) return set;
    if (name === "HOME") return this.home();
    if (name === "USER") return root ? "root" : this.host.user;
    if (name === "HOSTNAME") return this.host.name;
    return undefined;
  }

  /** A piece of a line as words, filled in now. `ran` is told what its `$( )` printed as errors and how the last one ended. */
  private words(text: string, opts: RunOptions, ran?: { err: string; code?: number }): Word[] {
    return this.tokens(text, opts, ran).filter((t): t is Word => !isOp(t));
  }

  private tokens(text: string, opts: RunOptions, ran?: { err: string; code?: number }): Token[] {
    return tokenize(text, {
      value: (name) => this.variable(name, opts.root),
      run: (script) => {
        const result = this.apart(() => this.exec(script, { root: opts.root, stdin: "" }));
        if (ran) {
          // What it wrote as errors goes to the terminal, not into the word.
          ran.err += result.err;
          ran.code = result.code;
        }
        return result.out.replace(/\n+$/, "");
      },
    });
  }

  private simple(text: string, opts: RunOptions): SimResult {
    const ran: { err: string; code?: number } = { err: "" };
    const stage = splitRedirects(this.tokens(text, opts, ran));
    const result = this.stage(stage, opts, ran.code);
    return ran.err ? { ...result, err: `${ran.err}${result.err}` } : result;
  }

  /** Runs a group with what follows it (`> file`, `2>&1`, `< file`) applied to all of it. */
  private redirected(written: string, opts: RunOptions, run: (opts: RunOptions) => SimResult): SimResult {
    if (!written) return run(opts);
    const { argv, redirects } = splitRedirects(this.tokens(written, opts));
    if (argv.length) throw unexpected(argv[0].text);
    const stdin = this.stdinOf(redirects, opts);
    if (typeof stdin !== "string") return stdin;
    return this.sendOutput(run({ root: opts.root, stdin }), redirects, opts.root);
  }

  /** What a command reads: the pipe before it, or the file after `<`. */
  private stdinOf(redirects: Redirect[], opts: RunOptions): string | SimResult {
    let stdin = opts.stdin;
    for (const r of redirects.filter((x) => x.op === "<")) {
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
    return stdin;
  }

  /** Sends what a command printed where its redirections say. */
  private sendOutput(ran: SimResult, redirects: Redirect[], root: boolean): SimResult {
    let result = ran;
    for (const r of redirects) {
      if (r.op === "<") continue;
      if (r.op === "2>&1") {
        result = { ...result, out: `${result.out}${result.err}`, err: "" };
        continue;
      }
      if (r.op === ">&2") {
        result = { ...result, out: "", err: `${result.err}${result.out}` };
        continue;
      }
      const both = r.op.startsWith("&");
      const errOnly = r.op.startsWith("2");
      const text = both ? `${result.out}${result.err}` : errOnly ? result.err : result.out;
      if (r.target !== "/dev/null") {
        const wrote = this.writeFile(r.target, text, r.op.endsWith(">>"), root);
        if (wrote) return fail(`bash: ${r.target}: ${wrote}\n`, 1);
      }
      result = { ...result, out: both || !errOnly ? "" : result.out, err: both || errOnly ? "" : result.err };
    }
    return result;
  }

  private stage(stage: Stage, opts: RunOptions, substituted?: number): SimResult {
    const stdin = this.stdinOf(stage.redirects, opts);
    if (typeof stdin !== "string") return stdin;
    if (stage.argv.length && stage.argv.every((w) => w.assign)) {
      // `name=value` by itself sets a variable of this shell. It ends as the `$( )` in it did.
      for (const w of stage.argv) {
        const eq = w.text.indexOf("=");
        this.vars.set(w.text.slice(0, eq), w.text.slice(eq + 1));
      }
      return this.sendOutput({ out: "", err: "", code: substituted ?? 0 }, stage.redirects, opts.root);
    }
    // Names with a pattern become the files they match; one that matches nothing stays as it was typed.
    const argv: string[] = [];
    for (const w of stage.argv) {
      if (w.quoted || w.assign || !/[*?[]/.test(w.text)) {
        argv.push(w.text);
        continue;
      }
      const matches = this.expand(w.text);
      argv.push(...(matches.length ? matches : [w.text]));
    }
    return this.sendOutput(this.dispatch(argv, { root: opts.root, stdin }), stage.redirects, opts.root);
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

  private dispatch(argv: string[], opts: RunOptions): SimResult {
    // VAR=value in front of a command: taken, and not acted on.
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
    if (!argv.length) return ok();
    const name = argv[0];
    // The shell's own no-op: what a connection is tested with.
    if (name === ":") return ok();
    const ctx: SimContext = { host: this.host, shell: this, cwd: this.cwd, root: opts.root, user: opts.root ? "root" : this.host.user, stdin: opts.stdin };
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
    // The shell's own words for its variables and for leaving. An appliance has a command line of its own.
    if (!this.host.only) {
      if (name === "exit") {
        const code = argv[1] === undefined ? this.lastCode : Number(argv[1]);
        if (!Number.isInteger(code)) return { out: "", err: `bash: exit: ${argv[1]}: numeric argument required\n`, code: 2, exit: true };
        return { out: "", err: "", code: code & 255, exit: true };
      }
      if (name === "export" || name === "unset") {
        for (const arg of argv.slice(1)) {
          const eq = arg.indexOf("=");
          if (name === "unset") this.vars.delete(arg);
          else if (eq > 0 && /^[A-Za-z_]\w*$/.test(arg.slice(0, eq))) this.vars.set(arg.slice(0, eq), arg.slice(eq + 1));
        }
        return ok();
      }
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
