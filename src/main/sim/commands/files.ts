import { createHash } from "node:crypto";
import { basename, dirname, normalizePath, type SimFile } from "../SimHost";
import { fail, globToRegExp, lines, NotSimulated, ok, parseArgs, type SimCommand, type SimContext, type SimResult } from "../SimShell";

/**
 * The file and text commands of a simulated server: what somebody types at a
 * prompt to look around and to change things. Each one reads the host's state
 * and answers the way the GNU tool does, as far as that goes; an option that
 * is not simulated is said to be so (NotSimulated) and never guessed at.
 */

// ---- shared helpers ------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIR_BYTES = 4096;
const two = (n: number): string => String(n).padStart(2, "0");

function regex(source: string, flags = ""): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern a user gave to grep, sed, awk or find: matching it is the command's job
  return new RegExp(source, flags);
}
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const abs = (ctx: SimContext, path: string): string => normalizePath(path, ctx.cwd);
const join = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);
const textLines = (text: string): string[] => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
const result = (out: string[], err: string[], code: number): SimResult => ({ out: lines(out), err: lines(err), code });

/** Long options said the short way, and anything that is not known refused. */
function only(name: string, flags: Set<string>, short: string, long: Record<string, string> = {}): void {
  for (const flag of [...flags]) {
    if (flag.length > 1 && flag in long) {
      flags.delete(flag);
      if (long[flag]) flags.add(long[flag]);
    } else if (flag.length > 1 || !short.includes(flag)) throw new NotSimulated(`${name} ${flag.length > 1 ? "--" : "-"}${flag}`);
  }
}

interface Entry {
  path: string;
  dir: boolean;
  size: number;
  mode: number;
  owner: string;
  mtime: number;
  file?: SimFile;
}

/** What is at a path. A folder has no record of its own: its owner and time follow from where it is and what is in it. */
function entryOf(ctx: SimContext, path: string): Entry | undefined {
  const file = ctx.host.read(path);
  if (file) return { path, dir: false, size: ctx.host.sizeOf(file), mode: file.mode & 0o7777, owner: file.owner, mtime: file.mtime, file };
  if (!ctx.host.isDir(path)) return undefined;
  const home = ctx.shell.home();
  let mtime = ctx.host.bootAt;
  for (const child of ctx.host.list(path)) {
    const inside = child.dir ? undefined : ctx.host.read(join(path, child.name));
    if (inside && inside.mtime > mtime) mtime = inside.mtime;
  }
  const sticky = path === "/tmp" || path === "/var/tmp";
  return { path, dir: true, size: DIR_BYTES, mode: sticky ? 0o1777 : 0o755, owner: path === home || path.startsWith(`${home}/`) ? ctx.host.user : "root", mtime };
}

interface Seen {
  entry: Entry;
  /** The path as the command prints it: under the name the user gave. */
  shown: string;
  depth: number;
}

/** A path and everything under it, parents first or (`post`) last. */
function tree(ctx: SimContext, path: string, shown: string, post: boolean, maxDepth = Infinity, depth = 0, into: Seen[] = []): Seen[] {
  const entry = entryOf(ctx, path);
  if (!entry) return into;
  if (!post) into.push({ entry, shown, depth });
  if (entry.dir && depth < maxDepth) for (const child of ctx.host.list(path)) tree(ctx, join(path, child.name), join(shown, child.name), post, maxDepth, depth + 1, into);
  if (post) into.push({ entry, shown, depth });
  return into;
}

/** Why a file cannot be read, in the system's words, or its text. `-` is what comes down the pipe. */
function slurp(ctx: SimContext, name: string): { text: string; why?: string; file?: SimFile } {
  if (name === "-") return { text: ctx.stdin };
  const path = abs(ctx, name);
  if (ctx.host.isDir(path)) return { text: "", why: "Is a directory" };
  const file = ctx.host.read(path);
  if (!file) return { text: "", why: "No such file or directory" };
  if (!ctx.shell.mayRead(path, ctx.root)) return { text: "", why: "Permission denied" };
  return { text: file.content, file };
}

/** Whether this user may take a path away: their own files, and what is in their own folder. */
function mayRemove(ctx: SimContext, path: string): boolean {
  if (ctx.root) return true;
  const file = ctx.host.read(path);
  if (file?.owner === ctx.host.user) return true;
  return path.startsWith(`${ctx.shell.home()}/`) || (!file && ctx.shell.mayWrite(path, false));
}

/** 1.5K, 23M, 4.0G: rounded up, the way ls -h and du -h do. */
function human(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  let value = bytes;
  for (const unit of ["K", "M", "G", "T", "P"]) {
    value /= 1024;
    if (value < 1024 || unit === "P") {
      const tenth = Math.ceil(value * 10 - 1e-9) / 10;
      return tenth < 10 ? `${tenth.toFixed(1)}${unit}` : `${Math.ceil(value - 1e-9)}${unit}`;
    }
  }
  return String(bytes);
}

function modeString(entry: Pick<Entry, "dir" | "mode">): string {
  const bits = "rwxrwxrwx";
  let text = entry.dir ? "d" : "-";
  for (let i = 0; i < 9; i++) text += entry.mode & (1 << (8 - i)) ? bits[i] : "-";
  if (entry.mode & 0o1000) text = `${text.slice(0, 9)}${entry.mode & 0o001 ? "t" : "T"}`;
  return text;
}

function lsDate(ms: number, now: number): string {
  const d = new Date(ms);
  const day = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)}`;
  const recent = ms > now - 182 * 86_400_000 && ms <= now + 3_600_000;
  return recent ? `${day} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : `${day}  ${d.getUTCFullYear()}`;
}

function longDate(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  return `${date} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}000000 +0000`;
}

const SYSTEM_UIDS: Record<string, number> = { root: 0, daemon: 1, "www-data": 33, nobody: 65534, postgres: 114, mysql: 115, nginx: 101, redis: 116 };
function uidOf(ctx: SimContext, owner: string): number {
  if (owner in SYSTEM_UIDS) return SYSTEM_UIDS[owner];
  if (owner === ctx.host.user) return 1000;
  let sum = 0;
  for (const ch of owner) sum += ch.charCodeAt(0);
  return 120 + (sum % 800);
}

function inodeOf(path: string): number {
  let hash = 7;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) % 2_000_000;
  return 130_000 + hash;
}

// ---- patterns ------------------------------------------------------------------

const POSIX_CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: "\\s",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9a-fA-F",
};

/** A POSIX pattern (basic, or extended) as the pattern JavaScript reads the same way. */
function posixToJs(pattern: string, extended: boolean): string {
  const special = "|(){}+?";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[++i];
      if (next === undefined) out += "\\";
      else if (next === "<" || next === ">") out += "\\b";
      else if (!extended && special.includes(next)) out += next;
      else out += `\\${next}`;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern.startsWith("[:", j)) {
          const end = pattern.indexOf(":]", j + 2);
          j = end < 0 ? pattern.length : end + 2;
        } else j += pattern[j] === "\\" ? 2 : 1;
      }
      if (j >= pattern.length) {
        // Never closed: left as it is, for the same complaint a real tool makes.
        out += pattern.slice(i);
        break;
      }
      let body = pattern.slice(i + 1, j);
      const negate = body.startsWith("^");
      if (negate) body = body.slice(1);
      body = body.replace(/\[:([a-z]+):\]/g, (_all, name: string) => POSIX_CLASSES[name] ?? "");
      if (body.startsWith("]")) body = `\\]${body.slice(1)}`;
      out += `[${negate ? "^" : ""}${body.replace(/\[/g, "\\[")}]`;
      i = j;
      continue;
    }
    out += !extended && special.includes(c) ? `\\${c}` : c;
  }
  return out;
}

/** What GNU says about a pattern it cannot read. */
function patternComplaint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unterminated character class|missing \/|Invalid character class|Range out of order/i.test(message)) return message.includes("Range") ? "Invalid range end" : "Unmatched [, [^, [:, [., or [=";
  if (/Unterminated group/i.test(message)) return "Unmatched ( or \\(";
  if (/Unmatched '\)'/i.test(message)) return "Unmatched ) or \\)";
  if (/Nothing to repeat/i.test(message)) return "Invalid preceding regular expression";
  if (/\\ at end of pattern/i.test(message)) return "Trailing backslash";
  return "Invalid regular expression";
}

class Complaint extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** A user's pattern, compiled; a Complaint in the tool's own words when it cannot be. */
function compile(pattern: string, extended: boolean, flags = ""): RegExp {
  try {
    return regex(posixToJs(pattern, extended), flags);
  } catch (error) {
    throw new Complaint(patternComplaint(error), 2);
  }
}

// ---- echo, printf and the like -------------------------------------------------

/** Backslash escapes as echo -e, printf and awk strings read them. */
function unescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\" || i === text.length - 1) {
      out += text[i];
      continue;
    }
    const next = text[++i];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "a") out += "\u0007";
    else if (next === "e") out += "\u001b";
    else if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "/") out += "/";
    else if (next === "0" || next === "x") {
      const digits = (next === "x" ? /^[0-9a-fA-F]{1,2}/ : /^[0-7]{1,3}/).exec(text.slice(i + 1))?.[0] ?? "";
      out += digits ? String.fromCharCode(parseInt(digits, next === "x" ? 16 : 8)) : next === "0" ? "\u0000" : "\\x";
      i += digits.length;
    } else out += `\\${next}`;
  }
  return out;
}

const echo: SimCommand = (_ctx, args) => {
  let newline = true;
  let escapes = false;
  let i = 0;
  for (; i < args.length && /^-[neE]+$/.test(args[i]); i++) {
    if (args[i].includes("n")) newline = false;
    for (const ch of args[i].slice(1)) if (ch !== "n") escapes = ch === "e";
  }
  let text = args.slice(i).join(" ");
  if (escapes) {
    const stop = text.indexOf("\\c");
    if (stop >= 0) {
      text = text.slice(0, stop);
      newline = false;
    }
    text = unescape(text);
  }
  return ok(newline ? `${text}\n` : text);
};

const awkNumber = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6))));

/** One pass of a printf format over the arguments it is given; says how many it took. */
function formatOnce(format: string, args: (string | number)[], from: number): { text: string; used: number } {
  let at = from;
  const text = format.replace(/%([-+ 0#]*)(\d*)(\.?)(\d*)([a-zA-Z%])/g, (all, flag: string, wide: string, dot: string, digits: string, kind: string) => {
    const width = wide || undefined;
    const precision = dot ? digits || "0" : undefined;
    if (kind === "%") return "%";
    if (!"sdiufeEgGxXocb".includes(kind)) throw new NotSimulated(`the printf conversion ${all}`);
    const raw = args[at++] ?? (kind === "s" || kind === "b" || kind === "c" ? "" : 0);
    const number = typeof raw === "number" ? raw : Number.parseFloat(raw) || 0;
    let body: string;
    if (kind === "s") body = typeof raw === "number" ? awkNumber(raw) : raw;
    else if (kind === "b") body = unescape(String(raw));
    else if (kind === "c") body = typeof raw === "number" ? String.fromCharCode(raw) : raw.slice(0, 1);
    else if (kind === "d" || kind === "i" || kind === "u") body = String(Math.trunc(number));
    else if (kind === "f") body = number.toFixed(precision === undefined ? 6 : Number(precision));
    else if (kind === "e" || kind === "E") body = number.toExponential(precision === undefined ? 6 : Number(precision)).replace(/e([+-])(\d)$/, "e$10$2");
    else if (kind === "g" || kind === "G") body = String(Number(number.toPrecision(precision === undefined ? 6 : Math.max(1, Number(precision)))));
    else if (kind === "o") body = Math.trunc(number).toString(8);
    else body = Math.trunc(number).toString(16);
    if (kind === "s" && precision !== undefined) body = body.slice(0, Number(precision));
    if (kind === "X" || kind === "E" || kind === "G") body = body.toUpperCase();
    if (flag.includes("+") && "dif".includes(kind) && number >= 0) body = `+${body}`;
    const size = width === undefined ? 0 : Number(width);
    if (flag.includes("-")) return body.padEnd(size);
    if (flag.includes("0") && !"sbc".includes(kind)) return body.startsWith("-") || body.startsWith("+") ? `${body[0]}${body.slice(1).padStart(size - 1, "0")}` : body.padStart(size, "0");
    return body.padStart(size);
  });
  return { text, used: at - from };
}

const printf: SimCommand = (_ctx, args) => {
  if (!args.length) return fail("printf: usage: printf [-v var] format [arguments]\n", 2);
  if (args[0] === "-v") throw new NotSimulated("printf -v");
  const format = unescape(args[0] === "--" ? (args[1] ?? "") : args[0]);
  const values = args.slice(args[0] === "--" ? 2 : 1);
  let out = "";
  let at = 0;
  // The format is used again for as long as there are arguments left, as the real one does.
  do {
    const once = formatOnce(format, values, at);
    out += once.text;
    if (!once.used) break;
    at += once.used;
  } while (at < values.length);
  return ok(out);
};

// ---- ls ------------------------------------------------------------------------

const blocksKb = (entry: Entry): number => (entry.dir ? 4 : Math.ceil(entry.size / 4096) * 4);

const ls: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args);
  only("ls", flags, "laAhd1trSRFpogG", { all: "a", "almost-all": "A", "human-readable": "h", directory: "d", reverse: "r", recursive: "R", classify: "F", color: "", "group-directories-first": "" });
  for (const key of values.keys()) if (key !== "color") throw new NotSimulated(`ls --${key}`);
  const long = flags.has("l") || flags.has("o") || flags.has("g");
  const now = ctx.host.now();
  const out: string[] = [];
  const err: string[] = [];

  const order = (list: { name: string; entry: Entry }[]): { name: string; entry: Entry }[] => {
    const sorted = [...list].sort((a, b) => {
      if (flags.has("t") && a.entry.mtime !== b.entry.mtime) return b.entry.mtime - a.entry.mtime;
      if (flags.has("S") && a.entry.size !== b.entry.size) return b.entry.size - a.entry.size;
      return a.name.localeCompare(b.name);
    });
    return flags.has("r") ? sorted.reverse() : sorted;
  };
  const mark = (entry: Entry): string => {
    if (entry.dir) return flags.has("F") || flags.has("p") ? "/" : "";
    return flags.has("F") && entry.mode & 0o111 ? "*" : "";
  };
  const show = (list: { name: string; entry: Entry }[]): string[] => {
    if (!long) return list.map((item) => `${item.name}${mark(item.entry)}`);
    const rows = list.map((item) => {
      const links = item.entry.dir ? 2 + ctx.host.list(item.entry.path).filter((child) => child.dir).length : 1;
      return { mode: modeString(item.entry), links: String(links), owner: item.entry.owner, size: flags.has("h") ? human(item.entry.size) : String(item.entry.size), date: lsDate(item.entry.mtime, now), name: `${item.name}${mark(item.entry)}` };
    });
    const width = (key: "links" | "owner" | "size"): number => Math.max(...rows.map((row) => row[key].length));
    return rows.map((row) => {
      const owner = flags.has("g") ? "" : `${row.owner.padEnd(width("owner"))} `;
      const group = flags.has("o") || flags.has("G") ? "" : `${row.owner.padEnd(width("owner"))} `;
      return `${row.mode} ${row.links.padStart(width("links"))} ${owner}${group}${row.size.padStart(width("size"))} ${row.date} ${row.name}`;
    });
  };
  const listDir = (path: string, shown: string, header: boolean): void => {
    if (out.length) out.push("");
    if (header) out.push(`${shown}:`);
    let items = ctx.host
      .list(path)
      .filter((child) => flags.has("a") || flags.has("A") || !child.name.startsWith("."))
      .map((child) => ({ name: child.name, entry: entryOf(ctx, join(path, child.name))! }));
    items = order(items);
    const all = [...items];
    if (flags.has("a")) {
      const dots = [
        { name: ".", entry: entryOf(ctx, path)! },
        { name: "..", entry: entryOf(ctx, dirname(path))! },
      ];
      if (flags.has("r")) all.push(...dots.reverse());
      else all.unshift(...dots);
    }
    if (long) {
      const kb = all.reduce((sum, item) => sum + blocksKb(item.entry), 0);
      out.push(`total ${flags.has("h") ? human(kb * 1024) : kb}`);
    }
    out.push(...show(all));
    if (flags.has("R")) for (const item of items) if (item.entry.dir) listDir(item.entry.path, join(shown, item.name), true);
  };

  const operands = rest.length ? rest : ["."];
  const plain: { name: string; entry: Entry }[] = [];
  const dirs: { name: string; entry: Entry }[] = [];
  for (const name of operands) {
    const entry = entryOf(ctx, abs(ctx, name));
    if (!entry) err.push(`ls: cannot access '${name}': No such file or directory`);
    else if (entry.dir && !flags.has("d")) dirs.push({ name, entry });
    else plain.push({ name, entry });
  }
  out.push(...show(order(plain)));
  const header = operands.length > 1 || flags.has("R");
  for (const dir of order(dirs)) listDir(dir.entry.path, dir.name, header);
  return result(out, err, err.length ? 2 : 0);
};

// ---- cat, head, tail -----------------------------------------------------------

const cat: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("cat", flags, "n", { number: "n" });
  let out = "";
  const err: string[] = [];
  for (const name of rest.length ? rest : ["-"]) {
    const got = slurp(ctx, name);
    if (got.why) err.push(`cat: ${name}: ${got.why}`);
    else out += got.text;
  }
  if (flags.has("n")) {
    const numbered = textLines(out).map((line, i) => `${String(i + 1).padStart(6)}\t${line}`);
    out = lines(numbered);
  }
  return { out, err: lines(err), code: err.length ? 1 : 0 };
};

const pager =
  (name: string): SimCommand =>
  (ctx, args) => {
    const files = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
    if (!files.length && !ctx.stdin) return fail(name === "less" ? 'Missing filename ("less --help" for help)\n' : "more: bad usage\nTry 'more --help' for more information.\n", 1);
    return cat(ctx, files);
  };

const editor =
  (name: string): SimCommand =>
  () =>
    fail(`${name}: this simulated terminal has no full-screen editor; edit with sed -i, tee or a redirection\n`, 1);

interface Slice {
  bytes: boolean;
  count: number;
  /** head -n -N (all but the last N), tail -n +N (from line N on). */
  inverse: boolean;
  files: string[];
}

function sliceArgs(name: "head" | "tail", args: string[]): Slice {
  const slice: Slice = { bytes: false, count: 10, inverse: false, files: [] };
  const amount = (text: string | undefined, bytes: boolean): void => {
    const m = /^([+-]?)(\d+)([kKmMgGb]?)$/.exec(text ?? "");
    if (!m) throw new Complaint(`invalid number of ${bytes ? "bytes" : "lines"}: '${text ?? ""}'`);
    const unit = { "": 1, b: 512, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[3].toLowerCase()] ?? 1;
    slice.bytes = bytes;
    slice.count = Number(m[2]) * unit;
    slice.inverse = name === "head" ? m[1] === "-" : m[1] === "+";
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      slice.files.push(...args.slice(i + 1));
      break;
    }
    if (/^-\d+$/.test(arg)) amount(arg.slice(1), false);
    else if (name === "tail" && /^\+\d+$/.test(arg)) amount(arg, false);
    else if (arg.startsWith("--lines=")) amount(arg.slice(8), false);
    else if (arg.startsWith("--bytes=")) amount(arg.slice(8), true);
    else if (["--follow", "--retry", "--quiet", "--silent", "--verbose"].includes(arg) || arg.startsWith("--follow=")) continue;
    else if (arg.startsWith("--")) throw new NotSimulated(`${name} ${arg}`);
    else if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "n" || flag === "c") {
          amount(arg.slice(j + 1) || args[++i], flag === "c");
          break;
        }
        if (!"fFqv".includes(flag)) throw new NotSimulated(`${name} -${flag}`);
      }
    } else slice.files.push(arg);
  }
  return slice;
}

const headOrTail =
  (name: "head" | "tail"): SimCommand =>
  (ctx, args) => {
    let slice: Slice;
    try {
      slice = sliceArgs(name, args);
    } catch (error) {
      if (error instanceof Complaint) return fail(`${name}: ${error.message}\n`, 1);
      throw error;
    }
    const cutText = (text: string): string => {
      const n = slice.count;
      if (slice.bytes) {
        const buffer = Buffer.from(text, "utf8");
        if (name === "head") return (slice.inverse ? buffer.subarray(0, Math.max(0, buffer.length - n)) : buffer.subarray(0, n)).toString("utf8");
        return (slice.inverse ? buffer.subarray(Math.max(0, n - 1)) : buffer.subarray(Math.max(0, buffer.length - n))).toString("utf8");
      }
      const all = textLines(text);
      let kept: string[];
      if (name === "head") kept = slice.inverse ? all.slice(0, Math.max(0, all.length - n)) : all.slice(0, n);
      else kept = slice.inverse ? all.slice(Math.max(0, n - 1)) : n === 0 ? [] : all.slice(-n);
      const whole = name === "tail" || kept.length === all.length;
      // The last line keeps the ending it had: a file without a final newline stays without one.
      return kept.length ? `${kept.join("\n")}${whole && !text.endsWith("\n") ? "" : "\n"}` : "";
    };
    const files = slice.files.length ? slice.files : ["-"];
    let out = "";
    const err: string[] = [];
    let first = true;
    for (const file of files) {
      const got = slurp(ctx, file);
      if (got.why) {
        err.push(got.why === "Is a directory" ? `${name}: error reading '${file}': Is a directory` : `${name}: cannot open '${file}' for reading: ${got.why}`);
        continue;
      }
      if (files.length > 1) out += `${first ? "" : "\n"}==> ${file === "-" ? "standard input" : file} <==\n`;
      first = false;
      out += cutText(got.text);
    }
    return { out, err: lines(err), code: err.length ? 1 : 0 };
  };

// ---- grep ----------------------------------------------------------------------

/** Options in the order they were given, for the commands where one may come more than once. */
function scan(args: string[], shortValued: string, longValued: string[]): { opts: { key: string; value?: string }[]; rest: string[] } {
  const opts: { key: string; value?: string }[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      if (eq >= 0) opts.push({ key, value: arg.slice(eq + 1) });
      else if (longValued.includes(key)) opts.push({ key, value: args[++i] });
      else opts.push({ key });
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (shortValued.includes(arg[j])) {
          opts.push({ key: arg[j], value: arg.slice(j + 1) || args[++i] });
          break;
        }
        opts.push({ key: arg[j] });
      }
      continue;
    }
    rest.push(arg);
  }
  return { opts, rest };
}

const GREP_LONG: Record<string, string> = {
  "ignore-case": "i",
  "invert-match": "v",
  count: "c",
  "line-number": "n",
  "files-with-matches": "l",
  "files-without-match": "L",
  recursive: "r",
  "dereference-recursive": "r",
  "extended-regexp": "E",
  "fixed-strings": "F",
  "perl-regexp": "P",
  "word-regexp": "w",
  "line-regexp": "x",
  quiet: "q",
  silent: "q",
  "only-matching": "o",
  "with-filename": "H",
  "no-filename": "h",
  "no-messages": "s",
  regexp: "e",
  "max-count": "m",
  "after-context": "A",
  "before-context": "B",
  context: "C",
  text: "a",
};

const grepAs =
  (name: string, forced: "" | "E" | "F"): SimCommand =>
  (ctx, args) => {
    const { opts, rest } = scan(args, "eABCmf", ["regexp", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir"]);
    const flags = new Set<string>(forced ? [forced] : []);
    const patterns: string[] = [];
    const include: RegExp[] = [];
    const exclude: RegExp[] = [];
    const excludeDir: RegExp[] = [];
    let before = 0;
    let after = 0;
    let max = Infinity;
    for (const opt of opts) {
      const key = GREP_LONG[opt.key] ?? opt.key;
      if (key === "color" || key === "colour" || key === "line-buffered" || key === "binary-files" || key === "null") continue;
      if (key === "include") include.push(globToRegExp(opt.value ?? ""));
      else if (key === "exclude") exclude.push(globToRegExp(opt.value ?? ""));
      else if (key === "exclude-dir") excludeDir.push(globToRegExp(opt.value ?? ""));
      else if (key === "e") patterns.push(opt.value ?? "");
      else if (key === "A" || key === "B" || key === "C" || key === "m") {
        const n = Number(opt.value);
        if (!Number.isInteger(n) || n < 0) return fail(`${name}: ${opt.value ?? ""}: invalid ${key === "m" ? "max count" : "context length argument"}\n`, 2);
        if (key === "m") max = n;
        if (key === "A" || key === "C") after = n;
        if (key === "B" || key === "C") before = n;
      } else if (key.length === 1 && "ivcnlLrREFPwxqoHhsaIU".includes(key)) flags.add(key === "R" ? "r" : key);
      else throw new NotSimulated(`${name} ${key.length > 1 ? "--" : "-"}${key}`);
    }
    const operands = [...rest];
    if (!patterns.length) {
      const first = operands.shift();
      if (first === undefined) return fail(`Usage: ${name} [OPTION]... PATTERNS [FILE]...\nTry '${name} --help' for more information.\n`, 2);
      patterns.push(first);
    }
    let test: RegExp;
    try {
      const extended = flags.has("E") || flags.has("P");
      const parts = patterns.flatMap((p) => p.split("\n")).map((p) => (flags.has("F") ? escapeRegex(p) : posixToJs(p, extended)));
      let source = parts.length > 1 ? parts.map((p) => `(?:${p})`).join("|") : parts[0];
      if (flags.has("x")) source = `^(?:${source})$`;
      else if (flags.has("w")) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
      test = regex(source, flags.has("i") ? "gi" : "g");
    } catch (error) {
      return fail(`${name}: ${patternComplaint(error)}\n`, 2);
    }

    const err: string[] = [];
    const out: string[] = [];
    let trouble = false;
    const complain = (file: string, why: string): void => {
      trouble = true;
      if (!flags.has("s")) err.push(`${name}: ${file}: ${why}`);
    };
    // The files to look in, each with the name it is printed under.
    const targets: { label: string; text: string }[] = [];
    const recursive = flags.has("r");
    if (!operands.length && !recursive) targets.push({ label: "(standard input)", text: ctx.stdin });
    for (const operand of operands.length ? operands : recursive ? [""] : []) {
      const path = abs(ctx, operand || ".");
      if (operand !== "-" && ctx.host.isDir(path)) {
        if (!recursive) {
          complain(operand, "Is a directory");
          continue;
        }
        const prefix = path === "/" ? "/" : `${path}/`;
        for (const file of ctx.host.under(path)) {
          const inside = file.slice(prefix.length);
          const leaf = basename(file);
          if (include.length && !include.some((g) => g.test(leaf))) continue;
          if (exclude.some((g) => g.test(leaf))) continue;
          if (excludeDir.length && inside.split("/").slice(0, -1).some((part) => excludeDir.some((g) => g.test(part)))) continue;
          const label = operand ? join(operand, inside) : inside;
          if (!ctx.shell.mayRead(file, ctx.root)) complain(label, "Permission denied");
          else targets.push({ label, text: ctx.host.read(file)!.content });
        }
        continue;
      }
      const got = slurp(ctx, operand);
      if (got.why) complain(operand, got.why);
      else targets.push({ label: operand === "-" ? "(standard input)" : operand, text: got.text });
    }
    const named = flags.has("H") || (!flags.has("h") && (recursive || operands.length > 1));
    const invert = flags.has("v");
    let selected = false;
    for (const target of targets) {
      const all = textLines(target.text);
      const hits: number[] = [];
      for (let i = 0; i < all.length && hits.length < max; i++) {
        test.lastIndex = 0;
        if (test.test(all[i]) !== invert) hits.push(i);
      }
      if (flags.has("L")) {
        if (!hits.length) {
          selected = true;
          if (!flags.has("q")) out.push(target.label);
        }
        continue;
      }
      if (hits.length) selected = true;
      if (flags.has("q")) continue;
      const prefix = named ? `${target.label}:` : "";
      if (flags.has("l")) {
        if (hits.length) out.push(target.label);
        continue;
      }
      if (flags.has("c")) {
        out.push(`${prefix}${hits.length}`);
        continue;
      }
      const number = (i: number, sep: string): string => (flags.has("n") ? `${i + 1}${sep}` : "");
      if (flags.has("o")) {
        if (invert) continue;
        for (const i of hits) for (const m of all[i].matchAll(test)) if (m[0]) out.push(`${prefix}${number(i, ":")}${m[0]}`);
        continue;
      }
      const hit = new Set(hits);
      let printed = -1;
      for (const i of hits) {
        const from = Math.max(i - before, printed + 1);
        if ((before || after) && printed >= 0 && from > printed + 1) out.push("--");
        for (let j = from; j <= Math.min(all.length - 1, i + after); j++) {
          if (j <= printed) continue;
          if (j > i && hit.has(j)) break;
          out.push(j === i ? `${prefix}${number(j, ":")}${all[j]}` : `${named ? `${target.label}-` : ""}${number(j, "-")}${all[j]}`);
          printed = j;
        }
      }
    }
    return result(out, err, trouble && !(flags.has("q") && selected) ? 2 : selected ? 0 : 1);
  };

// ---- wc, sort, uniq, cut, tr ---------------------------------------------------

const wc: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("wc", flags, "lwcm", { lines: "l", words: "w", bytes: "c", chars: "m" });
  const columns = (["l", "w", "m", "c"] as const).filter((key) => (flags.size ? flags.has(key) : key !== "m"));
  const rows: { counts: number[]; name: string }[] = [];
  const err: string[] = [];
  const order: (string | { counts: number[]; name: string })[] = [];
  const total = columns.map(() => 0);
  let widest = 0;
  for (const name of rest.length ? rest : ["-"]) {
    const got = slurp(ctx, name);
    if (got.why) {
      order.push(`wc: ${name}: ${got.why}`);
      err.push("");
      continue;
    }
    const pad = got.file?.pad ?? 0;
    const bytes = Buffer.byteLength(got.text, "utf8") + pad;
    const count = { l: got.text.split("\n").length - 1, w: got.text.split(/\s+/).filter(Boolean).length, m: [...got.text].length + pad, c: bytes };
    const counts = columns.map((key) => count[key]);
    counts.forEach((value, i) => (total[i] += value));
    widest += bytes;
    const row = { counts, name: rest.length ? name : "" };
    rows.push(row);
    order.push(row);
  }
  if (rest.length > 1) {
    const row = { counts: total, name: "total" };
    rows.push(row);
    order.push(row);
  }
  // GNU's columns: as wide as the largest byte count, 7 for a pipe, nothing for a single number.
  const width = columns.length === 1 && rows.length <= 1 ? 1 : !rest.length || rest.includes("-") ? 7 : Math.max(1, String(widest).length);
  const out: string[] = [];
  const errors: string[] = [];
  for (const item of order) {
    if (typeof item === "string") errors.push(item);
    else out.push(`${item.counts.map((value) => String(value).padStart(width)).join(" ")}${item.name ? ` ${item.name}` : ""}`);
  }
  return result(out, errors, err.length ? 1 : 0);
};

/** The text of the files named, or of the pipe: for the filters that treat several files as one. */
function gather(ctx: SimContext, name: string, files: string[], complaint = (file: string, why: string): string => `${name}: ${file}: ${why}`): { text: string; err: string[] } {
  let text = "";
  const err: string[] = [];
  for (const file of files.length ? files : ["-"]) {
    const got = slurp(ctx, file);
    if (got.why) err.push(complaint(file, got.why));
    else text += got.text && !got.text.endsWith("\n") ? `${got.text}\n` : got.text;
  }
  return { text, err };
}

const numberOf = (text: string): number => Number.parseFloat(text) || 0;
function humanNumber(text: string): number {
  const m = /^\s*(-?[\d.]+)\s*([KMGTPE]?)/i.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 1024 ** " KMGTPE".indexOf(m[2].toUpperCase() || " ");
}

const sort: SimCommand = (ctx, args) => {
  const { opts, rest } = scan(args, "ktoS", ["key", "field-separator", "output"]);
  const flags = new Set<string>();
  const keys: { from: number; to: number; flags: string }[] = [];
  let separator: string | undefined;
  let output: string | undefined;
  const long: Record<string, string> = { reverse: "r", "numeric-sort": "n", unique: "u", key: "k", "field-separator": "t", "human-numeric-sort": "h", "ignore-case": "f", output: "o", stable: "s", "version-sort": "V", "ignore-leading-blanks": "b", "general-numeric-sort": "g" };
  for (const opt of opts) {
    const key = long[opt.key] ?? opt.key;
    if (key === "t") separator = opt.value === "\\t" ? "\t" : opt.value;
    else if (key === "o") output = opt.value;
    else if (key === "k") {
      const [start, end, extra] = (opt.value ?? "").split(",");
      const from = /^(\d+)[.\d]*([a-zA-Z]*)$/.exec(start);
      const to = end === undefined ? undefined : /^(\d+)[.\d]*([a-zA-Z]*)$/.exec(end);
      if (!from || from[1] === "0" || to === null || extra !== undefined) return fail(`sort: invalid number at field start: invalid count at start of '${opt.value ?? ""}'\n`, 2);
      keys.push({ from: Number(from[1]), to: to ? Number(to[1]) : Infinity, flags: `${from[2]}${to?.[2] ?? ""}` });
    } else if (key.length === 1 && "rnuhfsVbg".includes(key)) flags.add(key === "g" ? "n" : key);
    else throw new NotSimulated(`sort ${key.length > 1 ? "--" : "-"}${key}`);
  }
  const got = gather(ctx, "sort", rest, (file, why) => `sort: cannot read: ${file}: ${why}`);
  if (got.err.length) return fail(lines(got.err), 2);
  const fields = (line: string): string[] => (separator === undefined ? line.trim().split(/[ \t]+/) : line.split(separator));
  const compareAs = (a: string, b: string, how: string): number => {
    let order: number;
    if (how.includes("n")) order = numberOf(a) - numberOf(b);
    else if (how.includes("h")) order = humanNumber(a) - humanNumber(b);
    else if (how.includes("V")) order = a.localeCompare(b, "en", { numeric: true });
    else {
      const x = how.includes("f") ? a.toUpperCase() : a;
      const y = how.includes("f") ? b.toUpperCase() : b;
      order = x < y ? -1 : x > y ? 1 : 0;
    }
    return how.includes("r") ? -order : order;
  };
  const global = [...flags].join("");
  const compare = (a: string, b: string): number => {
    if (!keys.length) return compareAs(a, b, global);
    for (const key of keys) {
      const part = (line: string): string =>
        fields(line)
          .slice(key.from - 1, key.to)
          .join(separator ?? " ");
      // A key's own letters take the place of the global ones, as in sort -k2,2nr.
      const order = compareAs(part(a), part(b), key.flags || global);
      if (order) return order;
    }
    return 0;
  };
  let sorted = textLines(got.text).sort((a, b) => compare(a, b) || (flags.has("u") || flags.has("s") ? 0 : (a < b ? -1 : a > b ? 1 : 0) * (flags.has("r") ? -1 : 1)));
  if (flags.has("u")) sorted = sorted.filter((line, i) => i === 0 || compare(sorted[i - 1], line) !== 0);
  if (output === undefined) return ok(lines(sorted));
  const wrote = ctx.shell.writeFile(abs(ctx, output), lines(sorted), false, ctx.root);
  return wrote ? fail(`sort: open failed: ${output}: ${wrote}\n`, 2) : ok();
};

const uniq: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("uniq", flags, "cdui", { count: "c", repeated: "d", unique: "u", "ignore-case": "i" });
  if (rest.length > 1) throw new NotSimulated("uniq with an output file");
  const got = gather(ctx, "uniq", rest);
  if (got.err.length) return fail(lines(got.err), 1);
  const groups: { line: string; count: number }[] = [];
  const same = (a: string, b: string): boolean => (flags.has("i") ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const line of textLines(got.text)) {
    const last = groups[groups.length - 1];
    if (last && same(last.line, line)) last.count++;
    else groups.push({ line, count: 1 });
  }
  const kept = groups.filter((g) => (flags.has("d") ? g.count > 1 : flags.has("u") ? g.count === 1 : true));
  return ok(lines(kept.map((g) => (flags.has("c") ? `${String(g.count).padStart(7)} ${g.line}` : g.line))));
};

/** A list as cut reads it: 1,3-5,7- */
function cutList(spec: string): ((n: number) => boolean) | undefined {
  const ranges: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part.trim());
    if (!m || (!m[1] && !m[3]) || m[1] === "0") return undefined;
    const from = m[1] ? Number(m[1]) : 1;
    ranges.push([from, m[2] ? (m[3] ? Number(m[3]) : Infinity) : from]);
  }
  return (n) => ranges.some(([from, to]) => n >= from && n <= to);
}

const cut: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["d", "f", "c", "b", "delimiter", "fields", "characters", "bytes", "output-delimiter"]);
  only("cut", flags, "s", { "only-delimited": "s" });
  const fieldSpec = values.get("f") ?? values.get("fields");
  const charSpec = values.get("c") ?? values.get("characters") ?? values.get("b") ?? values.get("bytes");
  if (fieldSpec === undefined && charSpec === undefined) return fail("cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.\n", 1);
  const wanted = cutList(fieldSpec ?? charSpec ?? "");
  if (!wanted) return fail(`cut: invalid ${fieldSpec === undefined ? "byte or character" : "field"} value '${fieldSpec ?? charSpec ?? ""}'\nTry 'cut --help' for more information.\n`, 1);
  const delimiter = values.get("d") ?? values.get("delimiter") ?? "\t";
  if (delimiter.length !== 1) return fail("cut: the delimiter must be a single character\nTry 'cut --help' for more information.\n", 1);
  const joiner = values.get("output-delimiter") ?? delimiter;
  const got = gather(ctx, "cut", rest);
  const out: string[] = [];
  for (const line of textLines(got.text)) {
    if (fieldSpec === undefined) out.push([...line].filter((_ch, i) => wanted(i + 1)).join(""));
    else if (!line.includes(delimiter)) {
      if (!flags.has("s")) out.push(line);
    } else
      out.push(
        line
          .split(delimiter)
          .filter((_field, i) => wanted(i + 1))
          .join(joiner),
      );
  }
  return result(out, got.err, got.err.length ? 1 : 0);
};

const TR_CLASSES: Record<string, string> = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digit: "0123456789",
  space: " \t\n\r\v\f",
  blank: " \t",
  punct: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
};
TR_CLASSES.alpha = TR_CLASSES.upper + TR_CLASSES.lower;
TR_CLASSES.alnum = TR_CLASSES.alpha + TR_CLASSES.digit;

function trSet(spec: string): string[] {
  const chars: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const named = /^\[:([a-z]+):\]/.exec(spec.slice(i));
    if (named) {
      if (!(named[1] in TR_CLASSES)) throw new Complaint(`invalid character class '${named[1]}'`);
      chars.push(...TR_CLASSES[named[1]]);
      i += named[0].length - 1;
      continue;
    }
    let ch = spec[i];
    if (ch === "\\" && i + 1 < spec.length) ch = unescape(`\\${spec[++i]}`).slice(-1);
    if (spec[i + 1] === "-" && i + 2 < spec.length) {
      const end = spec[i + 2] === "\\" && i + 3 < spec.length ? unescape(spec.slice(i + 2, i + 4)).slice(-1) : spec[i + 2];
      if (end.charCodeAt(0) < ch.charCodeAt(0)) throw new Complaint(`range-endpoints of '${ch}-${end}' are in reverse collating sequence order`);
      for (let code = ch.charCodeAt(0); code <= end.charCodeAt(0); code++) chars.push(String.fromCharCode(code));
      i += spec[i + 2] === "\\" ? 3 : 2;
      continue;
    }
    chars.push(ch);
  }
  return chars;
}

const tr: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("tr", flags, "dscC", { delete: "d", "squeeze-repeats": "s", complement: "c" });
  if (flags.has("C")) flags.add("c");
  if (!rest.length) return fail("tr: missing operand\nTry 'tr --help' for more information.\n", 1);
  try {
    const first = new Set(trSet(rest[0]));
    const inFirst = (ch: string): boolean => first.has(ch) !== flags.has("c");
    let text = ctx.stdin;
    let squeeze: ((ch: string) => boolean) | undefined;
    if (flags.has("d")) {
      text = [...text].filter((ch) => !inFirst(ch)).join("");
      if (flags.has("s") && rest[1] !== undefined) {
        const second = new Set(trSet(rest[1]));
        squeeze = (ch) => second.has(ch);
      }
    } else if (rest[1] !== undefined) {
      const to = trSet(rest[1]);
      if (!to.length) return fail("tr: when not truncating set1, string2 must be non-empty\n", 1);
      const from = [...first];
      const last = to[to.length - 1];
      // With -c every character that is not in the set becomes the last one of the second set.
      text = [...text].map((ch) => (flags.has("c") ? (first.has(ch) ? ch : last) : first.has(ch) ? (to[from.indexOf(ch)] ?? last) : ch)).join("");
      if (flags.has("s")) {
        const second = new Set(to);
        squeeze = (ch) => second.has(ch);
      }
    } else if (flags.has("s")) squeeze = inFirst;
    else return fail(`tr: missing operand after '${rest[0]}'\nTwo strings must be given when translating.\nTry 'tr --help' for more information.\n`, 1);
    if (squeeze) {
      const kept: string[] = [];
      for (const ch of text) if (!(squeeze(ch) && kept[kept.length - 1] === ch)) kept.push(ch);
      text = kept.join("");
    }
    return ok(text);
  } catch (error) {
    if (error instanceof Complaint) return fail(`tr: ${error.message}\n`, 1);
    throw error;
  }
};

// ---- awk -----------------------------------------------------------------------

const AWK = "this awk program";

interface AwkState {
  line: string;
  fields: string[];
  nr: number;
  file: string;
  ofs: string;
  fs: string;
  vars: Map<string, string | number>;
  out: string[];
}
type AwkValue = (state: AwkState) => string | number;
type AwkStatement = (state: AwkState) => "next" | "exit" | void;

/** Cuts a text at separators that stand outside strings, patterns and brackets. */
function splitTop(text: string, separators: string[]): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === "\\") current += text[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "/") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    const separator = depth === 0 ? separators.find((s) => text.startsWith(s, i)) : undefined;
    if (separator) {
      parts.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

const awkText = (value: string | number): string => (typeof value === "number" ? awkNumber(value) : value);
const looksNumeric = (value: string | number): boolean => typeof value === "number" || /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/.test(value);
const awkField = (state: AwkState, n: number): string => (n === 0 ? state.line : (state.fields[n - 1] ?? ""));

/** What stands after `print`, or on one side of a comparison: fields, strings, numbers and names, set side by side. */
function awkExpression(text: string): AwkValue {
  const term = /\s*(?:"((?:[^"\\]|\\.)*)"|(\$NF)|\$\(\s*NF\s*-\s*(\d+)\s*\)|\$(\d+)|(\d[\d.]*)|([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)|([A-Za-z_][A-Za-z0-9_]*))/y;
  const parts: AwkValue[] = [];
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    term.lastIndex = at;
    const m = term.exec(text);
    if (!m) throw new NotSimulated(AWK);
    at = term.lastIndex;
    if (m[1] !== undefined) {
      const literal = unescape(m[1]);
      parts.push(() => literal);
    } else if (m[2]) parts.push((s) => awkField(s, s.fields.length));
    else if (m[3] !== undefined) {
      const back = Number(m[3]);
      parts.push((s) => (s.fields.length - back >= 0 ? awkField(s, s.fields.length - back) : ""));
    } else if (m[4] !== undefined) {
      const n = Number(m[4]);
      parts.push((s) => awkField(s, n));
    } else if (m[5] !== undefined) {
      const n = Number(m[5]);
      parts.push(() => n);
    } else {
      const name = m[6] ?? m[8];
      if (m[7] !== undefined) {
        if (name !== "length") throw new NotSimulated(AWK);
        const inner = m[7].trim();
        const of = inner ? awkExpression(inner) : (s: AwkState): string => s.line;
        parts.push((s) => awkText(of(s)).length);
      } else if (name === "NR") parts.push((s) => s.nr);
      else if (name === "NF") parts.push((s) => s.fields.length);
      else if (name === "FILENAME") parts.push((s) => s.file);
      else if (name === "length") parts.push((s) => s.line.length);
      else parts.push((s) => s.vars.get(name) ?? "");
    }
  }
  if (!parts.length) throw new NotSimulated(AWK);
  return parts.length === 1 ? parts[0] : (s) => parts.map((part) => awkText(part(s))).join("");
}

function awkCondition(text: string): (state: AwkState) => boolean {
  const source = text.trim();
  if (!source) return () => true;
  const any = splitTop(source, ["||"]);
  if (any.length > 1) {
    const tests = any.map(awkCondition);
    return (s) => tests.some((t) => t(s));
  }
  const all = splitTop(source, ["&&"]);
  if (all.length > 1) {
    const tests = all.map(awkCondition);
    return (s) => tests.every((t) => t(s));
  }
  const bare = /^(!?)\s*\/(.*)\/$/s.exec(source);
  if (bare && splitTop(source, ["~", "==", "!=", "<", ">"]).length === 1) {
    const test = compile(bare[2], true);
    return (s) => test.test(s.line) !== (bare[1] === "!");
  }
  for (const op of ["!~", ">=", "<=", "==", "!=", "~", ">", "<"]) {
    const sides = splitTop(source, [op]);
    if (sides.length !== 2) continue;
    const left = awkExpression(sides[0]);
    if (op === "~" || op === "!~") {
      const pattern = /^\s*\/(.*)\/\s*$/s.exec(sides[1]) ?? /^\s*"(.*)"\s*$/s.exec(sides[1]);
      if (!pattern) throw new NotSimulated(AWK);
      const test = compile(pattern[1], true);
      return (s) => test.test(awkText(left(s))) === (op === "~");
    }
    const right = awkExpression(sides[1]);
    return (s) => {
      const a = left(s);
      const b = right(s);
      const order = looksNumeric(a) && looksNumeric(b) ? Number(a) - Number(b) : awkText(a) < awkText(b) ? -1 : awkText(a) > awkText(b) ? 1 : 0;
      return op === "==" ? order === 0 : op === "!=" ? order !== 0 : op === ">" ? order > 0 : op === "<" ? order < 0 : op === ">=" ? order >= 0 : order <= 0;
    };
  }
  throw new NotSimulated(AWK);
}

function awkAssign(state: AwkState, name: string, value: string | number): void {
  if (name === "FS") state.fs = awkText(value);
  else if (name === "OFS") state.ofs = awkText(value);
  else state.vars.set(name, value);
}

function awkStatement(text: string): AwkStatement {
  const source = text.trim();
  if (!source) return () => undefined;
  if (source === "next" || source === "exit") return () => source;
  if (source === "print") return (s) => void s.out.push(`${s.line}\n`);
  const printing = /^print(f?)(?![A-Za-z0-9_])(.*)$/s.exec(source);
  if (printing) {
    let list = printing[2].trim();
    if (list.startsWith("(") && list.endsWith(")") && splitTop(list, [","]).length === 1) list = list.slice(1, -1);
    const values = splitTop(list, [","]).map(awkExpression);
    if (!printing[1]) return (s) => void s.out.push(`${values.map((value) => awkText(value(s))).join(s.ofs)}\n`);
    return (s) => void s.out.push(formatOnce(awkText(values[0](s)), values.slice(1).map((value) => value(s)), 0).text);
  }
  const counted = /^(?:\+\+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\+\+)$/.exec(source);
  if (counted) {
    const name = counted[1] ?? counted[2];
    return (s) => void s.vars.set(name, (Number(s.vars.get(name)) || 0) + 1);
  }
  const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|=)(?!=)(.*)$/s.exec(source);
  if (assigned) {
    const [, name, op] = assigned;
    const value = awkExpression(assigned[3]);
    if (op === "=") return (s) => awkAssign(s, name, value(s));
    return (s) => void s.vars.set(name, (Number(s.vars.get(name)) || 0) + (op === "+=" ? 1 : -1) * (Number.parseFloat(awkText(value(s))) || 0));
  }
  throw new NotSimulated(AWK);
}

interface AwkRule {
  when: "BEGIN" | "END" | "line";
  test: (state: AwkState) => boolean;
  run: AwkStatement[];
}

function awkProgram(program: string): AwkRule[] {
  const rules: AwkRule[] = [];
  let i = 0;
  const rule = (pattern: string, body: string | undefined): void => {
    const head = pattern.trim().replace(/^;+\s*/, "");
    if (!head && body === undefined) return;
    const when = head === "BEGIN" || head === "END" ? head : "line";
    const run = body === undefined ? [awkStatement("print")] : splitTop(body, [";", "\n"]).map(awkStatement);
    rules.push({ when, test: when === "line" ? awkCondition(head) : () => true, run });
  };
  while (i < program.length) {
    let pattern = "";
    let quote = "";
    for (; i < program.length; i++) {
      const c = program[i];
      if (quote) {
        if (c === "\\") pattern += program[i++];
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "/") quote = c;
      else if (c === "{") break;
      pattern += program[i] ?? "";
    }
    if (i >= program.length) {
      rule(pattern, undefined);
      break;
    }
    let body = "";
    let closed = false;
    for (i++; i < program.length; i++) {
      const c = program[i];
      if (quote) {
        if (c === "\\") body += program[i++];
        else if (c === quote) quote = "";
      } else if (c === '"') quote = c;
      else if (c === "{") throw new NotSimulated(AWK);
      else if (c === "}") {
        closed = true;
        i++;
        break;
      }
      body += program[i] ?? "";
    }
    if (!closed) throw new Complaint("syntax error: unexpected end of program", 1);
    rule(pattern, body);
  }
  return rules;
}

const awk: SimCommand = (ctx, args) => {
  const state: AwkState = { line: "", fields: [], nr: 0, file: "", ofs: " ", fs: " ", vars: new Map(), out: [] };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (rest.length || !arg.startsWith("-") || arg === "-") rest.push(arg);
    else if (arg === "--") rest.push(...args.splice(i + 1));
    else if (arg.startsWith("-F")) state.fs = unescape(arg.slice(2) || (args[++i] ?? " "));
    else if (arg.startsWith("-v")) {
      const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg.slice(2) || (args[++i] ?? ""));
      if (!pair) return fail("awk: fatal: `-v' requires an assignment of the form var=value\n", 2);
      awkAssign(state, pair[1], looksNumeric(pair[2]) && pair[2].trim() ? Number(pair[2]) : unescape(pair[2]));
    } else throw new NotSimulated(`awk ${arg}`);
  }
  const program = rest.shift();
  if (program === undefined) return fail("Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\n", 2);
  let rules: AwkRule[];
  try {
    rules = awkProgram(program);
  } catch (error) {
    if (error instanceof Complaint) return fail(`awk: cmd. line:1: ${error.message}\n`, 1);
    throw error;
  }
  const err: string[] = [];
  const run = (when: AwkRule["when"]): "next" | "exit" | void => {
    for (const rule of rules) {
      if (rule.when !== when || !rule.test(state)) continue;
      for (const statement of rule.run) {
        const flow = statement(state);
        if (flow) return flow;
      }
    }
  };
  const exited = run("BEGIN") === "exit";
  const needsInput = rules.some((rule) => rule.when !== "BEGIN");
  if (needsInput && !exited) {
    let splitter: RegExp | string | undefined;
    let splitterFor: string | undefined;
    reading: for (const file of rest.length ? rest : ["-"]) {
      const got = slurp(ctx, file);
      if (got.why) {
        err.push(`awk: fatal: cannot open file \`${file}' for reading: ${got.why}`);
        return { out: state.out.join(""), err: lines(err), code: 2 };
      }
      state.file = file === "-" ? "" : file;
      for (const line of textLines(got.text)) {
        if (splitterFor !== state.fs) {
          splitterFor = state.fs;
          splitter = state.fs === " " ? undefined : state.fs === "\t" || state.fs.length === 1 ? state.fs : compile(state.fs, true);
        }
        state.nr++;
        state.line = line;
        state.fields = splitter === undefined ? line.trim().split(/[ \t]+/).filter(Boolean) : line === "" ? [] : line.split(splitter);
        if (run("line") === "exit") break reading;
      }
    }
  }
  run("END");
  return { out: state.out.join(""), err: lines(err), code: 0 };
};

// ---- sed -----------------------------------------------------------------------

interface SedAddress {
  line?: number;
  last?: boolean;
  test?: RegExp;
}
interface SedCommand {
  first?: SedAddress;
  second?: SedAddress;
  /** addr,+N */
  plus?: number;
  negate: boolean;
  name: string;
  test?: RegExp;
  replace?: (groups: string[]) => string;
  print?: boolean;
  text?: string;
  active: boolean;
  until: number;
}

const SED_UNSUPPORTED = "{}yYnNhHgGxwWrRbtTlDPFezv:#";

function sedReplacement(raw: string): (groups: string[]) => string {
  const parts: (string | number)[] = [];
  let literal = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "&") {
      parts.push(literal, 0);
      literal = "";
    } else if (c === "\\" && i + 1 < raw.length) {
      const next = raw[++i];
      if (/\d/.test(next)) {
        parts.push(literal, Number(next));
        literal = "";
      } else if (next === "n") literal += "\n";
      else if (next === "t") literal += "\t";
      else if ("ULulE".includes(next)) throw new NotSimulated(`the sed replacement \\${next}`);
      else literal += next;
    } else literal += c;
  }
  parts.push(literal);
  return (groups) => parts.map((part) => (typeof part === "number" ? (groups[part] ?? "") : part)).join("");
}

function sedScript(script: string, extended: boolean): SedCommand[] {
  const commands: SedCommand[] = [];
  let i = 0;
  const bad = (what: string): Complaint => new Complaint(`-e expression #1, char ${Math.min(i + 1, script.length)}: ${what}`);
  /** Text up to the next separator that is not escaped; an escaped separator stands for itself. */
  const delimited = (delimiter: string, asPattern: boolean, what: string): string => {
    let text = "";
    for (; i < script.length; i++) {
      const c = script[i];
      if (c === delimiter) {
        i++;
        return text;
      }
      if (c === "\\" && i + 1 < script.length) {
        const next = script[++i];
        if (next === delimiter && delimiter !== "\\") text += asPattern ? (extended || !"|(){}+?".includes(delimiter) ? `\\${delimiter}` : delimiter) : /[&\d]/.test(delimiter) ? `\\${delimiter}` : delimiter;
        else text += `\\${next}`;
      } else text += c;
    }
    throw bad(what);
  };
  const pattern = (source: string, flags: string): RegExp => {
    if (!source) throw new NotSimulated("an empty sed pattern (the last one used)");
    try {
      return regex(posixToJs(source, extended), flags);
    } catch (error) {
      throw bad(patternComplaint(error));
    }
  };
  const address = (): SedAddress | undefined => {
    const number = /^\d+/.exec(script.slice(i))?.[0];
    if (number) {
      i += number.length;
      if (script[i] === "~") throw new NotSimulated("a sed step address (first~step)");
      return { line: Number(number) };
    }
    if (script[i] === "$") {
      i++;
      return { last: true };
    }
    if (script[i] === "/" || script[i] === "\\") {
      const delimiter = script[i] === "\\" ? script[++i] : "/";
      i++;
      const source = delimited(delimiter, true, "unterminated address regex");
      let flags = "";
      if (script[i] === "I") {
        flags = "i";
        i++;
      }
      return { test: pattern(source, flags) };
    }
    return undefined;
  };
  const blanks = (): void => {
    while (script[i] === " " || script[i] === "\t") i++;
  };
  while (i < script.length) {
    if (" \t\n;".includes(script[i])) {
      i++;
      continue;
    }
    const command: SedCommand = { negate: false, name: "", active: false, until: 0 };
    command.first = address();
    if (command.first && script[i] === ",") {
      i++;
      blanks();
      const more = /^\+(\d+)/.exec(script.slice(i));
      if (more) {
        command.plus = Number(more[1]);
        i += more[0].length;
      } else {
        command.second = address();
        if (!command.second) throw bad("unexpected `,'");
      }
    }
    blanks();
    while (script[i] === "!") {
      command.negate = !command.negate;
      i++;
      blanks();
    }
    const name = script[i++];
    if (name === undefined) throw bad("missing command");
    command.name = name;
    if (name === "s") {
      const delimiter = script[i++];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") throw bad("unterminated `s' command");
      const source = delimited(delimiter, true, "unterminated `s' command");
      const replacement = delimited(delimiter, false, "unterminated `s' command");
      let flags = "";
      for (; i < script.length && !" \t\n;}".includes(script[i]); i++) {
        const flag = script[i];
        if (flag === "g") flags += flags.includes("g") ? "" : "g";
        else if (flag === "i" || flag === "I") flags += flags.includes("i") ? "" : "i";
        else if (flag === "p") command.print = true;
        else if (/[0-9wemM]/.test(flag)) throw new NotSimulated(`the sed s flag '${flag}'`);
        else throw bad("unknown option to `s'");
      }
      command.test = pattern(source, flags);
      command.replace = sedReplacement(replacement);
    } else if ("aic".includes(name)) {
      blanks();
      if (script[i] === "\\") {
        i++;
        if (script[i] === "\n") i++;
        else blanks();
      }
      const end = script.indexOf("\n", i);
      command.text = unescape(script.slice(i, end < 0 ? script.length : end));
      if (!command.text) throw bad("expected \\ after `a', `c' or `i'");
      i = end < 0 ? script.length : end;
    } else if ("pd=q".includes(name)) {
      if (name === "q") while (/\d/.test(script[i] ?? "")) i++;
    } else if (SED_UNSUPPORTED.includes(name)) throw new NotSimulated(`the sed command '${name}'`);
    else throw bad(`unknown command: \`${name}'`);
    blanks();
    if (i < script.length && !";\n".includes(script[i])) throw bad("extra characters after command");
    commands.push(command);
  }
  return commands;
}

function sedRun(commands: SedCommand[], input: string, quiet: boolean): string {
  const all = textLines(input);
  const out: string[] = [];
  for (const command of commands) command.active = false;
  for (let n = 1; n <= all.length; n++) {
    let space = all[n - 1];
    const last = n === all.length;
    const after: string[] = [];
    let deleted = false;
    let quit = false;
    const hit = (address: SedAddress): boolean => (address.line !== undefined ? n === address.line : address.last ? last : address.test!.test(space));
    const selects = (command: SedCommand): boolean => {
      let chosen: boolean;
      if (!command.first) chosen = true;
      else if (!command.second && command.plus === undefined) chosen = hit(command.first);
      else if (command.active) {
        chosen = true;
        if (command.plus !== undefined ? n >= command.until : command.second!.line !== undefined ? n >= command.second!.line : hit(command.second!)) command.active = false;
      } else if (hit(command.first)) {
        chosen = true;
        if (command.plus !== undefined) {
          command.until = n + command.plus;
          command.active = command.plus > 0;
        } else command.active = command.second!.line !== undefined ? command.second!.line > n : !last;
      } else chosen = false;
      return chosen !== command.negate;
    };
    for (const command of commands) {
      if (!selects(command)) continue;
      if (command.name === "d") deleted = true;
      else if (command.name === "p") out.push(space);
      else if (command.name === "=") out.push(String(n));
      else if (command.name === "q") quit = true;
      else if (command.name === "a") after.push(command.text!);
      else if (command.name === "i") out.push(command.text!);
      else if (command.name === "c") {
        deleted = true;
        // A range is replaced once, when it ends.
        if (!command.active) out.push(command.text!);
      } else if (command.name === "s") {
        let changed = false;
        space = space.replace(command.test!, (...found: unknown[]) => {
          changed = true;
          const end = found.findIndex((part) => typeof part === "number");
          return command.replace!(found.slice(0, end) as string[]);
        });
        if (changed && command.print) out.push(space);
      }
      if (deleted || quit) break;
    }
    if (!deleted && !quiet) out.push(space);
    out.push(...after);
    if (quit) break;
  }
  return lines(out);
}

const sed: SimCommand = (ctx, args) => {
  let quiet = false;
  let extended = false;
  let inPlace: string | undefined;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--quiet" || arg === "--silent") quiet = true;
    else if (arg === "--regexp-extended") extended = true;
    else if (arg === "--in-place" || arg.startsWith("--in-place=")) inPlace = arg.slice(11);
    else if (arg.startsWith("--expression=")) scripts.push(arg.slice(13));
    else if (arg === "--expression") scripts.push(args[++i] ?? "");
    else if (arg === "--separate" || arg === "--posix" || arg === "--sandbox") continue;
    else if (arg.startsWith("--")) throw new NotSimulated(`sed ${arg}`);
    else if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "n") quiet = true;
        else if (flag === "E" || flag === "r") extended = true;
        else if (flag === "s" || flag === "u") continue;
        else if (flag === "e") {
          scripts.push(arg.slice(j + 1) || (args[++i] ?? ""));
          break;
        } else if (flag === "i") {
          inPlace = arg.slice(j + 1);
          break;
        } else throw new NotSimulated(`sed -${flag}`);
      }
    } else rest.push(arg);
  }
  if (!scripts.length) {
    const script = rest.shift();
    if (script === undefined) return fail("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n", 1);
    scripts.push(script);
  }
  let commands: SedCommand[];
  try {
    commands = sedScript(scripts.join("\n"), extended);
  } catch (error) {
    if (error instanceof Complaint) return fail(`sed: ${error.message}\n`, 1);
    throw error;
  }
  if (inPlace === undefined) {
    const got = gather(ctx, "sed", rest, (file, why) => (why === "Is a directory" ? `sed: read error on ${file}: Is a directory` : `sed: can't read ${file}: ${why}`));
    return { out: sedRun(commands, got.text, quiet), err: lines(got.err), code: got.err.length ? 2 : 0 };
  }
  if (!rest.length) return fail("sed: no input files\n", 1);
  const err: string[] = [];
  let code = 0;
  for (const name of rest) {
    const path = abs(ctx, name);
    const got = slurp(ctx, name);
    if (got.why === "Is a directory") {
      err.push(`sed: couldn't edit ${name}: not a regular file`);
      code = 4;
      continue;
    }
    if (got.why) {
      err.push(`sed: can't read ${name}: ${got.why}`);
      code ||= 2;
      continue;
    }
    // sed -i writes a new file beside the old one: it needs the right to write there.
    if (!ctx.shell.mayWrite(path, ctx.root)) {
      err.push(`sed: couldn't open temporary file ${join(dirname(path), "sedXq7RfB")}: Permission denied`);
      code = 4;
      continue;
    }
    if (inPlace) {
      const backup = inPlace.includes("*") ? join(dirname(path), inPlace.replace(/\*/g, basename(path))) : `${path}${inPlace}`;
      if (!ctx.host.hasRoomFor(backup, ctx.host.sizeOf(got.file!))) {
        err.push(`sed: couldn't write ${textLines(got.text).length} items to ${backup}: No space left on device`);
        code = 4;
        continue;
      }
      ctx.host.write(backup, got.text, { pad: got.file!.pad ?? 0, mode: got.file!.mode, owner: got.file!.owner, mtime: got.file!.mtime });
    }
    const wrote = ctx.shell.writeFile(path, sedRun(commands, got.text, quiet), false, ctx.root);
    if (wrote) {
      err.push(`sed: couldn't flush ${join(dirname(path), "sedXq7RfB")}: ${wrote}`);
      code = 4;
    }
  }
  return { out: "", err: lines(err), code };
};

// ---- find and du ---------------------------------------------------------------

const find: SimCommand = (ctx, args) => {
  const words = [...args];
  while (["-L", "-H", "-P"].includes(words[0])) words.shift();
  const starts: string[] = [];
  while (words.length && !words[0].startsWith("-") && words[0] !== "!" && words[0] !== "(") starts.push(words.shift()!);
  if (!starts.length) starts.push(".");
  const now = ctx.host.now();
  const groups: ((seen: Seen) => boolean)[][] = [[]];
  let maxDepth = Infinity;
  let minDepth = 0;
  let remove = false;
  let nul = false;
  let printfFmt: string | undefined;
  let negate = false;
  const add = (test: (seen: Seen) => boolean): void => {
    const flipped = negate;
    negate = false;
    groups[groups.length - 1].push(flipped ? (seen) => !test(seen) : test);
  };
  const value = (name: string): string => {
    const next = words.shift();
    if (next === undefined) throw new Complaint(`missing argument to \`${name}'`);
    return next;
  };
  /** +N, -N or N against a measured amount. */
  const compare = (name: string, spec: string, measure: (seen: Seen, unit: string) => number, units = ""): ((seen: Seen) => boolean) => {
    const m = /^([+-]?)(\d+)([a-zA-Z]?)$/.exec(spec);
    if (!m || (m[3] && !units.includes(m[3]))) throw new Complaint(`invalid argument \`${spec}' to \`${name}'`);
    const n = Number(m[2]);
    return (seen) => {
      const got = measure(seen, m[3]);
      return m[1] === "+" ? got > n : m[1] === "-" ? got < n : got === n;
    };
  };
  const err: string[] = [];
  try {
    while (words.length) {
      const word = words.shift()!;
      if (word === "!" || word === "-not") negate = !negate;
      else if (word === "-a" || word === "-and") continue;
      else if (word === "-o" || word === "-or") groups.push([]);
      else if (word === "(" || word === ")") throw new NotSimulated("find with parentheses");
      else if (word === "-name" || word === "-iname") {
        const test = regex(globToRegExp(value(word)).source, word === "-iname" ? "i" : "");
        add((seen) => test.test(seen.entry.path === "/" ? "/" : basename(seen.entry.path)));
      } else if (word === "-path" || word === "-wholename" || word === "-ipath") {
        const source = globToRegExp(value(word)).source.replace(/\[\^\/\]\*/g, ".*").replace(/\[\^\/\]/g, ".");
        const test = regex(source, word === "-ipath" ? "i" : "");
        add((seen) => test.test(seen.shown));
      } else if (word === "-type") {
        const kinds = value(word).split(",");
        if (kinds.some((kind) => !"fdlbcps".includes(kind) || kind.length !== 1)) throw new Complaint(`Unknown argument to -type: ${kinds.join(",")}`);
        add((seen) => kinds.includes(seen.entry.dir ? "d" : "f"));
      } else if (word === "-maxdepth" || word === "-mindepth") {
        const n = Number(value(word));
        if (!Number.isInteger(n) || n < 0) throw new Complaint(`Expected a positive decimal integer argument to ${word}`);
        if (word === "-maxdepth") maxDepth = n;
        else minDepth = n;
      } else if (word === "-mtime") add(compare(word, value(word), (seen) => Math.floor((now - seen.entry.mtime) / 86_400_000)));
      else if (word === "-mmin") {
        const spec = value(word);
        const exact = /^\d/.test(spec);
        add(compare(word, spec, (seen) => (exact ? Math.ceil((now - seen.entry.mtime) / 60_000) : (now - seen.entry.mtime) / 60_000)));
      } else if (word === "-size") {
        const units: Record<string, number> = { "": 512, b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };
        add(compare(word, value(word), (seen, unit) => Math.ceil(seen.entry.size / units[unit]), "bcwkMG"));
      } else if (word === "-newer") {
        const name = value(word);
        const other = entryOf(ctx, abs(ctx, name));
        if (!other) throw new Complaint(`'${name}': No such file or directory`);
        add((seen) => seen.entry.mtime > other.mtime);
      } else if (word === "-user") {
        const who = value(word);
        add((seen) => seen.entry.owner === who);
      } else if (word === "-empty") add((seen) => (seen.entry.dir ? ctx.host.list(seen.entry.path).length === 0 : seen.entry.size === 0));
      else if (word === "-print") add(() => true);
      else if (word === "-print0") nul = true;
      else if (word === "-printf") printfFmt = value(word);
      else if (word === "-delete") remove = true;
      else if (word === "-depth" || word === "-xdev" || word === "-mount" || word === "-noleaf") continue;
      else if (word === "-exec" || word === "-execdir" || word === "-ok") throw new NotSimulated("find -exec");
      else throw new NotSimulated(`find ${word}`);
    }
  } catch (error) {
    if (error instanceof Complaint) return fail(`find: ${error.message}\n`, 1);
    throw error;
  }
  const formatPrintf = (fmt: string, seen: Seen): string => {
    const d = new Date(seen.entry.mtime);
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    return fmt
      .replace(/\\([nt\\])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"))
      .replace(/%(%|p|f|h|s|m|u|y|T@|TY|Tm|Td|TH|TM|TS)/g, (_m, tok: string) => {
        if (tok === "%") return "%";
        if (tok === "p") return seen.shown;
        if (tok === "f") return seen.entry.path === "/" ? "/" : basename(seen.entry.path);
        if (tok === "h") return seen.shown.includes("/") ? seen.shown.slice(0, seen.shown.lastIndexOf("/")) || "/" : ".";
        if (tok === "s") return String(seen.entry.size);
        if (tok === "m") return (seen.entry.mode & 0o7777).toString(8);
        if (tok === "u") return seen.entry.owner;
        if (tok === "y") return seen.entry.dir ? "d" : "f";
        if (tok === "T@") return (seen.entry.mtime / 1000).toFixed(2);
        if (tok === "TY") return String(d.getUTCFullYear());
        if (tok === "Tm") return pad2(d.getUTCMonth() + 1);
        if (tok === "Td") return pad2(d.getUTCDate());
        if (tok === "TH") return pad2(d.getUTCHours());
        if (tok === "TM") return pad2(d.getUTCMinutes());
        if (tok === "TS") return pad2(d.getUTCSeconds());
        return `%${tok}`;
      });
  };
  const out: string[] = [];
  for (const start of starts) {
    const top = abs(ctx, start);
    if (!ctx.host.exists(top)) {
      err.push(`find: '${start}': No such file or directory`);
      continue;
    }
    for (const seen of tree(ctx, top, start, remove, maxDepth)) {
      if (seen.depth < minDepth || !groups.some((group) => group.every((test) => test(seen)))) continue;
      if (!remove) {
        out.push(printfFmt !== undefined ? formatPrintf(printfFmt, seen) : seen.shown);
        continue;
      }
      if (seen.entry.dir && ctx.host.list(seen.entry.path).length) err.push(`find: cannot delete '${seen.shown}': Directory not empty`);
      else if (!mayRemove(ctx, seen.entry.path)) err.push(`find: cannot delete '${seen.shown}': Permission denied`);
      else if (seen.entry.path !== "/") ctx.host.remove(seen.entry.path);
    }
  }
  return { out: printfFmt !== undefined ? out.join("") : nul ? out.map((path) => `${path}\u0000`).join("") : lines(out), err: lines(err), code: err.length ? 1 : 0 };
};

const du: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["d", "max-depth"]);
  only("du", flags, "shackmbxlL", { summarize: "s", "human-readable": "h", all: "a", total: "c", bytes: "b", "apparent-size": "", "one-file-system": "x" });
  for (const key of values.keys()) if (key !== "d" && key !== "max-depth") throw new NotSimulated(`du --${key}`);
  const depthText = values.get("d") ?? values.get("max-depth");
  if (depthText !== undefined && !/^\d+$/.test(depthText)) return fail(`du: invalid maximum depth '${depthText}'\nTry 'du --help' for more information.\n`, 1);
  if (flags.has("s") && flags.has("a")) return fail("du: cannot both summarize and show all entries\nTry 'du --help' for more information.\n", 1);
  const maxDepth = flags.has("s") ? 0 : depthText === undefined ? Infinity : Number(depthText);
  const exact = flags.has("b");
  const show = (bytes: number): string => (flags.has("h") ? human(bytes) : exact ? String(bytes) : flags.has("m") ? String(Math.ceil(bytes / 1024 ** 2)) : String(Math.ceil(bytes / 1024)));
  const out: string[] = [];
  const err: string[] = [];
  let total = 0;
  const visit = (path: string, shown: string, depth: number): number => {
    const entry = entryOf(ctx, path)!;
    let bytes = entry.dir ? DIR_BYTES : exact ? entry.size : Math.ceil(entry.size / 4096) * 4096;
    if (entry.dir) for (const child of ctx.host.list(path)) bytes += visit(join(path, child.name), join(shown, child.name), depth + 1);
    if (depth <= maxDepth && (entry.dir || flags.has("a") || depth === 0)) out.push(`${show(bytes)}\t${shown}`);
    return bytes;
  };
  for (const name of rest.length ? rest : ["."]) {
    const path = abs(ctx, name);
    if (!ctx.host.exists(path)) err.push(`du: cannot access '${name}': No such file or directory`);
    else total += visit(path, name, 0);
  }
  if (flags.has("c")) out.push(`${show(total)}\ttotal`);
  return result(out, err, err.length ? 1 : 0);
};

// ---- stat, file ----------------------------------------------------------------

const stat: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["c", "format", "printf"]);
  only("stat", flags, "L", { dereference: "L" });
  const format = values.get("c") ?? values.get("format");
  const raw = values.get("printf");
  if (!rest.length) return fail("stat: missing operand\nTry 'stat --help' for more information.\n", 1);
  let out = "";
  const err: string[] = [];
  for (const name of rest) {
    const entry = entryOf(ctx, abs(ctx, name));
    if (!entry) {
      err.push(`stat: cannot statx '${name}': No such file or directory`);
      continue;
    }
    const kind = entry.dir ? "directory" : entry.size ? "regular file" : "regular empty file";
    const octal = entry.mode.toString(8);
    const uid = uidOf(ctx, entry.owner);
    const blocks = entry.dir ? 8 : Math.ceil(entry.size / 4096) * 8;
    const links = entry.dir ? 2 + ctx.host.list(entry.path).filter((child) => child.dir).length : 1;
    const seconds = Math.floor(entry.mtime / 1000);
    const fields: Record<string, string> = {
      n: name,
      N: `'${name}'`,
      s: String(entry.size),
      a: octal,
      A: modeString(entry),
      U: entry.owner,
      G: entry.owner,
      u: String(uid),
      g: String(uid),
      F: kind,
      b: String(blocks),
      B: "512",
      o: "4096",
      h: String(links),
      i: String(inodeOf(entry.path)),
      d: "2049",
      x: longDate(entry.mtime),
      y: longDate(entry.mtime),
      z: longDate(entry.mtime),
      w: "-",
      X: String(seconds),
      Y: String(seconds),
      Z: String(seconds),
      W: "0",
      "%": "%",
    };
    const fill = (template: string): string =>
      template.replace(/%(.)/g, (all, key: string) => {
        if (!(key in fields)) throw new NotSimulated(`the stat format ${all}`);
        return fields[key];
      });
    if (raw !== undefined) out += fill(unescape(raw));
    else if (format !== undefined) out += `${fill(format)}\n`;
    else
      out += lines([
        `  File: ${name}`,
        `  Size: ${String(entry.size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: 4096   ${kind}`,
        `Device: 8,1\tInode: ${String(inodeOf(entry.path)).padEnd(11)} Links: ${links}`,
        `Access: (${octal.padStart(4, "0")}/${modeString(entry)})  Uid: (${String(uid).padStart(5)}/${entry.owner.padStart(8)})   Gid: (${String(uid).padStart(5)}/${entry.owner.padStart(8)})`,
        `Access: ${longDate(entry.mtime)}`,
        `Modify: ${longDate(entry.mtime)}`,
        `Change: ${longDate(entry.mtime)}`,
        " Birth: -",
      ]);
  }
  return { out, err: lines(err), code: err.length ? 1 : 0 };
};

const fileType: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("file", flags, "bL", { brief: "b", dereference: "L" });
  if (!rest.length) return fail("Usage: file [-bL] file ...\n", 1);
  const width = Math.max(...rest.map((name) => name.length)) + 1;
  const out = rest.map((name) => {
    const path = abs(ctx, name);
    const entry = entryOf(ctx, path);
    let what: string;
    if (!entry) what = `cannot open \`${name}' (No such file or directory)`;
    else if (entry.dir) what = "directory";
    else if (!ctx.shell.mayRead(path, ctx.root)) what = "regular file, no read permission";
    else if (entry.size === 0) what = "empty";
    else if (entry.file?.pad) what = "data";
    else {
      const text = entry.file!.content;
      const ascii = [...text].every((ch) => ch.charCodeAt(0) < 128);
      const long = textLines(text).some((line) => line.length > 300) ? ", with very long lines" : "";
      const shebang = /^#!\s*(\S+)[ \t]*(\S*)/.exec(text);
      const interpreter = shebang ? basename(shebang[1] === "/usr/bin/env" ? (shebang[2] || "env") : shebang[1]) : "";
      if (interpreter === "bash") what = "Bourne-Again shell script, ASCII text executable";
      else if (interpreter === "sh" || interpreter === "dash") what = "POSIX shell script, ASCII text executable";
      else if (interpreter.startsWith("python")) what = "Python script, ASCII text executable";
      else if (text.startsWith("-----BEGIN CERTIFICATE-----")) what = "PEM certificate";
      else if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) what = text.startsWith("-----BEGIN OPENSSH") ? "OpenSSH private key" : "PEM RSA private key";
      else if (/^\s*[{[]/.test(text) && name.endsWith(".json")) what = "JSON text data";
      else what = `${ascii ? "ASCII text" : "Unicode text, UTF-8 text"}${long}`;
    }
    return flags.has("b") ? what : `${`${name}:`.padEnd(width)} ${what}`;
  });
  return ok(lines(out));
};

// ---- making, moving and removing -----------------------------------------------

const touch: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("touch", flags, "cam", { "no-create": "c" });
  if (!rest.length) return fail("touch: missing file operand\nTry 'touch --help' for more information.\n", 1);
  const err: string[] = [];
  for (const name of rest) {
    const path = abs(ctx, name);
    const file = ctx.host.read(path);
    if (ctx.host.isDir(path)) continue;
    if (file) {
      if (!ctx.shell.mayWrite(path, ctx.root)) err.push(`touch: cannot touch '${name}': Permission denied`);
      else file.mtime = ctx.host.now();
    } else if (!flags.has("c")) {
      const wrote = ctx.shell.writeFile(path, "", false, ctx.root);
      if (wrote) err.push(`touch: cannot touch '${name}': ${wrote}`);
    }
  }
  return result([], err, err.length ? 1 : 0);
};

const mkdir: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args, ["m", "mode"]);
  only("mkdir", flags, "pv", { parents: "p", verbose: "v" });
  if (!rest.length) return fail("mkdir: missing operand\nTry 'mkdir --help' for more information.\n", 1);
  const out: string[] = [];
  const err: string[] = [];
  for (const name of rest) {
    const path = abs(ctx, name);
    const refuse = (why: string): number => err.push(`mkdir: cannot create directory '${name}': ${why}`);
    if (ctx.host.isDir(path)) {
      if (!flags.has("p")) refuse("File exists");
    } else if (ctx.host.read(path)) refuse("File exists");
    else if (!flags.has("p") && !ctx.host.isDir(dirname(path))) refuse(ctx.host.read(dirname(path)) ? "Not a directory" : "No such file or directory");
    else if (!ctx.shell.mayWrite(path, ctx.root)) refuse("Permission denied");
    else {
      // With -p every folder that had to be made is named, the outermost first.
      const made: string[] = [];
      for (let at = path, shown = name.replace(/\/+$/, ""); !ctx.host.isDir(at) && shown; at = dirname(at), shown = shown.includes("/") ? shown.slice(0, shown.lastIndexOf("/")) : "") made.unshift(shown);
      ctx.host.mkdir(path);
      if (flags.has("v")) out.push(...made.map((shown) => `mkdir: created directory '${shown}'`));
    }
  }
  return result(out, err, err.length ? 1 : 0);
};

const rmdir: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("rmdir", flags, "v", { verbose: "v", "ignore-fail-on-non-empty": "" });
  if (!rest.length) return fail("rmdir: missing operand\nTry 'rmdir --help' for more information.\n", 1);
  const err: string[] = [];
  for (const name of rest) {
    const path = abs(ctx, name);
    const refuse = (why: string): number => err.push(`rmdir: failed to remove '${name}': ${why}`);
    if (ctx.host.read(path)) refuse("Not a directory");
    else if (!ctx.host.isDir(path)) refuse("No such file or directory");
    else if (ctx.host.list(path).length) refuse("Directory not empty");
    else if (path === "/") refuse("Device or resource busy");
    else if (!mayRemove(ctx, path)) refuse("Permission denied");
    else ctx.host.remove(path);
  }
  return result([], err, err.length ? 1 : 0);
};

const rm: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("rm", flags, "rRfvdiI", { recursive: "r", force: "f", verbose: "v", dir: "d", "preserve-root": "", "no-preserve-root": "", "one-file-system": "" });
  const recursive = flags.has("r") || flags.has("R");
  const force = flags.has("f");
  if (!rest.length) return force ? ok() : fail("rm: missing operand\nTry 'rm --help' for more information.\n", 1);
  const paths = rest.map((name) => abs(ctx, name));
  const top = ctx.host.list("/").map((entry) => `/${entry.name}`);
  // `rm -rf /*` comes here as every folder under /: as fatal as `/` itself, and refused the same way.
  if (recursive && (paths.includes("/") || rest.includes("/*") || (top.length > 0 && top.every((path) => paths.includes(path))))) {
    return fail("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n", 1);
  }
  const out: string[] = [];
  const err: string[] = [];
  rest.forEach((name, i) => {
    const path = paths[i];
    const refuse = (what: string, why: string): number => err.push(`rm: cannot remove '${what}': ${why}`);
    if (/(^|\/)\.\.?\/*$/.test(name)) {
      err.push(`rm: refusing to remove '.' or '..' directory: skipping '${name}'`);
      return;
    }
    if (!ctx.host.exists(path)) {
      if (!force) refuse(name, "No such file or directory");
      return;
    }
    if (!ctx.host.isDir(path)) {
      if (!mayRemove(ctx, path)) refuse(name, "Permission denied");
      else {
        ctx.host.remove(path);
        if (flags.has("v")) out.push(`removed '${name}'`);
      }
      return;
    }
    if (!recursive) {
      if (!flags.has("d")) refuse(name, "Is a directory");
      else if (ctx.host.list(path).length) refuse(name, "Directory not empty");
      else if (!mayRemove(ctx, path)) refuse(name, "Permission denied");
      else ctx.host.remove(path);
      return;
    }
    // What may go goes; what may not stays, with the folders that still hold something.
    for (const seen of tree(ctx, path, name, true)) {
      if (seen.entry.dir && ctx.host.list(seen.entry.path).length) continue;
      if (!mayRemove(ctx, seen.entry.path)) refuse(seen.shown, "Permission denied");
      else {
        ctx.host.remove(seen.entry.path);
        if (flags.has("v")) out.push(seen.entry.dir ? `removed directory '${seen.shown}'` : `removed '${seen.shown}'`);
      }
    }
  });
  return result(out, err, err.length ? 1 : 0);
};

/** Puts a copy of a file at a path. Says what went wrong in the system's words. */
function putFile(ctx: SimContext, source: SimFile, to: string, keep: boolean): string | undefined {
  const host = ctx.host;
  if (!host.isDir(dirname(to))) return host.read(dirname(to)) ? "Not a directory" : "No such file or directory";
  if (!ctx.shell.mayWrite(to, ctx.root)) return "Permission denied";
  const had = host.read(to);
  const grows = host.sizeOf(source) - (had ? host.sizeOf(had) : 0);
  if (grows > 0 && !host.hasRoomFor(to, grows)) return "No space left on device";
  host.write(to, source.content, {
    pad: source.pad ?? 0,
    mode: keep || !had ? source.mode : had.mode,
    owner: keep && ctx.root ? source.owner : (had?.owner ?? ctx.user),
    mtime: keep ? source.mtime : host.now(),
  });
  return undefined;
}

/** Where each source of `cp a b c dir` or `mv a b` goes. */
function destinations(ctx: SimContext, name: string, rest: string[]): { pairs: { from: string; to: string }[]; error?: string } {
  if (!rest.length) return { pairs: [], error: `${name}: missing file operand\nTry '${name} --help' for more information.\n` };
  if (rest.length === 1) return { pairs: [], error: `${name}: missing destination file operand after '${rest[0]}'\nTry '${name} --help' for more information.\n` };
  const target = rest[rest.length - 1];
  const into = ctx.host.isDir(abs(ctx, target));
  if (rest.length > 2 && !into) return { pairs: [], error: `${name}: target '${target}' ${ctx.host.exists(abs(ctx, target)) ? "is not a directory" : "is not a directory"}\n` };
  return { pairs: rest.slice(0, -1).map((from) => ({ from, to: into ? join(target, basename(normalizePath(from, ctx.cwd))) : target })) };
}

const cp: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("cp", flags, "rRapvfniudT", { recursive: "r", archive: "a", verbose: "v", force: "f", "no-clobber": "n", preserve: "p", update: "u", "no-dereference": "" });
  const recursive = flags.has("r") || flags.has("R") || flags.has("a");
  const keep = flags.has("p") || flags.has("a");
  const plan = destinations(ctx, "cp", rest);
  if (plan.error) return fail(plan.error, 1);
  const out: string[] = [];
  const err: string[] = [];
  const copy = (source: string, shownFrom: string, to: string, shownTo: string): void => {
    const file = ctx.host.read(source)!;
    if (source === to) return void err.push(`cp: '${shownFrom}' and '${shownTo}' are the same file`);
    if (!ctx.shell.mayRead(source, ctx.root)) return void err.push(`cp: cannot open '${shownFrom}' for reading: Permission denied`);
    const had = ctx.host.read(to);
    if (had && (flags.has("n") || (flags.has("u") && had.mtime >= file.mtime))) return;
    const wrong = putFile(ctx, file, to, keep);
    if (wrong === "No space left on device") err.push(`cp: error writing '${shownTo}': ${wrong}`);
    else if (wrong) err.push(`cp: cannot create regular file '${shownTo}': ${wrong}`);
    else if (flags.has("v")) out.push(`'${shownFrom}' -> '${shownTo}'`);
  };
  for (const pair of plan.pairs) {
    const from = abs(ctx, pair.from);
    const to = abs(ctx, pair.to);
    if (!ctx.host.exists(from)) err.push(`cp: cannot stat '${pair.from}': No such file or directory`);
    else if (!ctx.host.isDir(from)) copy(from, pair.from, to, pair.to);
    else if (!recursive) err.push(`cp: -r not specified; omitting directory '${pair.from}'`);
    else if (to === from || to.startsWith(`${from}/`)) err.push(`cp: cannot copy a directory, '${pair.from}', into itself, '${pair.to}'`);
    else if (ctx.host.read(to)) err.push(`cp: cannot overwrite non-directory '${pair.to}' with directory '${pair.from}'`);
    else if (!ctx.host.isDir(dirname(to))) err.push(`cp: cannot create directory '${pair.to}': No such file or directory`);
    else if (!ctx.host.isDir(to) && !ctx.shell.mayWrite(to, ctx.root)) err.push(`cp: cannot create directory '${pair.to}': Permission denied`);
    else {
      for (const seen of tree(ctx, from, pair.from, false)) {
        const inside = seen.entry.path.slice(from.length);
        if (seen.entry.dir) {
          if (!ctx.host.isDir(`${to}${inside}`) && flags.has("v")) out.push(`'${seen.shown}' -> '${pair.to}${inside}'`);
          ctx.host.mkdir(`${to}${inside}`);
        } else copy(seen.entry.path, seen.shown, `${to}${inside}`, `${pair.to}${inside}`);
      }
    }
  }
  return result(out, err, err.length ? 1 : 0);
};

const mv: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("mv", flags, "fvniuT", { force: "f", verbose: "v", "no-clobber": "n", update: "u" });
  const plan = destinations(ctx, "mv", rest);
  if (plan.error) return fail(plan.error, 1);
  const host = ctx.host;
  const out: string[] = [];
  const err: string[] = [];
  for (const pair of plan.pairs) {
    const from = abs(ctx, pair.from);
    const to = abs(ctx, pair.to);
    const refuse = (why: string): number => err.push(`mv: cannot move '${pair.from}' to '${pair.to}': ${why}`);
    if (!host.exists(from)) {
      err.push(`mv: cannot stat '${pair.from}': No such file or directory`);
      continue;
    }
    if (from === to) {
      err.push(`mv: '${pair.from}' and '${pair.to}' are the same file`);
      continue;
    }
    const isDir = host.isDir(from);
    if (isDir && to.startsWith(`${from}/`)) {
      err.push(`mv: cannot move '${pair.from}' to a subdirectory of itself, '${pair.to}'`);
      continue;
    }
    if (isDir && host.read(to)) {
      err.push(`mv: cannot overwrite non-directory '${pair.to}' with directory '${pair.from}'`);
      continue;
    }
    if (!isDir && host.isDir(to)) {
      err.push(`mv: cannot overwrite directory '${pair.to}' with non-directory`);
      continue;
    }
    if (host.read(to) && flags.has("n")) continue;
    if (!host.isDir(dirname(to))) {
      refuse(host.read(dirname(to)) ? "Not a directory" : "No such file or directory");
      continue;
    }
    if (isDir && host.isDir(to) && host.list(to).length) {
      refuse("Directory not empty");
      continue;
    }
    const moved = tree(ctx, from, pair.from, false);
    if (from === "/" || !moved.every((seen) => mayRemove(ctx, seen.entry.path)) || !ctx.shell.mayWrite(to, ctx.root)) {
      refuse("Permission denied");
      continue;
    }
    // Onto another filesystem the bytes have to fit there; on the same one a move takes no room.
    const replaced = host.read(to);
    if (host.diskOf(from) !== host.diskOf(to) && !host.hasRoomFor(to, host.usage(from) - (replaced ? host.sizeOf(replaced) : 0))) {
      err.push(`mv: error writing '${pair.to}': No space left on device`);
      continue;
    }
    for (const seen of moved) {
      const target = `${to}${seen.entry.path.slice(from.length)}`;
      if (seen.entry.dir) host.mkdir(target);
      else host.files.set(target, seen.entry.file!);
    }
    if (isDir) host.remove(from);
    else host.files.delete(from);
    if (flags.has("v")) out.push(`renamed '${pair.from}' -> '${pair.to}'`);
  }
  return result(out, err, err.length ? 1 : 0);
};

const ln: SimCommand = () => {
  throw new NotSimulated("making links");
};

const tee: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("tee", flags, "ai", { append: "a", "ignore-interrupts": "i" });
  const err: string[] = [];
  for (const name of rest) {
    const wrote = ctx.shell.writeFile(abs(ctx, name), ctx.stdin, flags.has("a"), ctx.root);
    if (wrote) err.push(`tee: ${name}: ${wrote}`);
  }
  return { out: ctx.stdin, err: lines(err), code: err.length ? 1 : 0 };
};

// ---- chmod, chown --------------------------------------------------------------

/** The mode a file gets from `644` or `u+x,go-w`; nothing when that is not a mode. */
function newMode(spec: string, old: number): number | undefined {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = old;
  for (const clause of spec.split(",")) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!m) return undefined;
    const who = m[1] && !m[1].includes("a") ? m[1] : "ugo";
    let bits = 0;
    for (const letter of m[3]) {
      const bit = letter === "r" ? 4 : letter === "w" ? 2 : letter === "x" || (letter === "X" && old & 0o111) ? 1 : 0;
      for (const w of who) bits |= bit << (w === "u" ? 6 : w === "g" ? 3 : 0);
      if (letter === "t") bits |= 0o1000;
    }
    if (m[2] === "+") mode |= bits;
    else if (m[2] === "-") mode &= ~bits;
    else {
      let mask = 0;
      for (const w of who) mask |= 7 << (w === "u" ? 6 : w === "g" ? 3 : 0);
      mode = (mode & ~mask) | bits;
    }
  }
  return mode;
}

/** The options of chmod and chown, where the first plain word (even `-x`) is what to set. */
function changeArgs(name: string, args: string[]): { recursive: boolean; verbose: boolean; what?: string; files: string[] } {
  const parsed = { recursive: false, verbose: false, what: undefined as string | undefined, files: [] as string[] };
  for (const arg of args) {
    if (parsed.what === undefined && /^-[Rvcfh]+$/.test(arg)) {
      if (arg.includes("R")) parsed.recursive = true;
      if (arg.includes("v") || arg.includes("c")) parsed.verbose = true;
    } else if (arg === "--recursive") parsed.recursive = true;
    else if (arg === "--verbose" || arg === "--changes") parsed.verbose = true;
    else if (arg.startsWith("--") && arg.length > 2) throw new NotSimulated(`${name} ${arg}`);
    else if (arg === "--") continue;
    else if (parsed.what === undefined) parsed.what = arg;
    else parsed.files.push(arg);
  }
  return parsed;
}

const change =
  (name: "chmod" | "chown" | "chgrp"): SimCommand =>
  (ctx, args) => {
    const parsed = changeArgs(name, args);
    if (parsed.what === undefined) return fail(`${name}: missing operand\nTry '${name} --help' for more information.\n`, 1);
    if (!parsed.files.length) return fail(`${name}: missing operand after '${parsed.what}'\nTry '${name} --help' for more information.\n`, 1);
    if (name === "chmod" && newMode(parsed.what, 0) === undefined) return fail(`chmod: invalid mode: '${parsed.what}'\nTry 'chmod --help' for more information.\n`, 1);
    const owner = name === "chown" ? parsed.what.split(/[:.]/)[0] : "";
    const out: string[] = [];
    const err: string[] = [];
    for (const file of parsed.files) {
      const path = abs(ctx, file);
      if (!ctx.host.exists(path)) {
        err.push(`${name}: cannot access '${file}': No such file or directory`);
        continue;
      }
      // A folder keeps no mode or owner of its own here: only the files in it change.
      for (const seen of parsed.recursive ? tree(ctx, path, file, false) : [{ entry: entryOf(ctx, path)!, shown: file, depth: 0 }]) {
        const target = seen.entry.file;
        if (name === "chmod") {
          if (!ctx.root && seen.entry.owner !== ctx.host.user) err.push(`chmod: changing permissions of '${seen.shown}': Operation not permitted`);
          else if (target) {
            const mode = newMode(parsed.what, target.mode)!;
            if (parsed.verbose && mode !== target.mode) out.push(`mode of '${seen.shown}' changed from ${target.mode.toString(8).padStart(4, "0")} (${modeString(seen.entry).slice(1)}) to ${mode.toString(8).padStart(4, "0")} (${modeString({ dir: false, mode }).slice(1)})`);
            target.mode = mode;
          }
        } else if (!ctx.root && !(name === "chown" && (!owner || owner === seen.entry.owner) && seen.entry.owner === ctx.host.user)) {
          err.push(`${name}: changing ${name === "chown" ? "ownership" : "group"} of '${seen.shown}': Operation not permitted`);
        } else if (target && owner) {
          if (parsed.verbose && owner !== target.owner) out.push(`changed ownership of '${seen.shown}' from ${target.owner} to ${owner}`);
          target.owner = owner;
        }
      }
    }
    return result(out, err, err.length ? 1 : 0);
  };

// ---- names and sums ------------------------------------------------------------

const stripSlashes = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") || "/" : path);

const basenameCommand: SimCommand = (_ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["s", "suffix"]);
  only("basename", flags, "az", { multiple: "a" });
  if (!rest.length) return fail("basename: missing operand\nTry 'basename --help' for more information.\n", 1);
  const many = flags.has("a") || values.has("s") || values.has("suffix");
  const suffix = values.get("s") ?? values.get("suffix") ?? (many ? "" : (rest[1] ?? ""));
  const names = (many ? rest : rest.slice(0, 1)).map((path) => {
    const stripped = stripSlashes(path);
    const name = stripped === "/" ? "/" : basename(stripped);
    return suffix && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
  });
  return ok(lines(names));
};

const dirnameCommand: SimCommand = (_ctx, args) => {
  if (!args.length) return fail("dirname: missing operand\nTry 'dirname --help' for more information.\n", 1);
  return ok(
    lines(
      args.map((path) => {
        const stripped = stripSlashes(path);
        if (!stripped.includes("/")) return ".";
        return stripSlashes(stripped.slice(0, stripped.lastIndexOf("/"))) || "/";
      }),
    ),
  );
};

const realpath: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("realpath", flags, "mesq", { "canonicalize-missing": "m", "canonicalize-existing": "e", "no-symlinks": "s", quiet: "q" });
  if (!rest.length) return fail("realpath: missing operand\nTry 'realpath --help' for more information.\n", 1);
  const out: string[] = [];
  const err: string[] = [];
  for (const name of rest) {
    const path = abs(ctx, name);
    const there = flags.has("m") || (flags.has("e") ? ctx.host.exists(path) : ctx.host.exists(path) || ctx.host.isDir(dirname(path)));
    if (there) out.push(path);
    else err.push(`realpath: ${name}: No such file or directory`);
  }
  return result(out, err, err.length ? 1 : 0);
};

const readlink: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  only("readlink", flags, "fmenqsv", { canonicalize: "f", "canonicalize-missing": "m", "canonicalize-existing": "e", "no-newline": "n" });
  if (!rest.length) return fail("readlink: missing operand\nTry 'readlink --help' for more information.\n", 1);
  // No links are simulated: without -f there is nothing to read, as for any plain file.
  if (!flags.has("f") && !flags.has("m") && !flags.has("e")) return { out: "", err: "", code: 1 };
  const paths = rest.map((name) => abs(ctx, name)).filter((path) => !flags.has("e") || ctx.host.exists(path));
  const text = flags.has("n") ? paths.join("\n") : lines(paths);
  return { out: text, err: "", code: paths.length === rest.length ? 0 : 1 };
};

const checksum =
  (name: string, algorithm: string): SimCommand =>
  (ctx, args) => {
    const { flags, rest } = parseArgs(args);
    if (flags.has("c") || flags.has("check")) throw new NotSimulated(`${name} -c`);
    only(name, flags, "bt", { binary: "b", text: "t" });
    const out: string[] = [];
    const err: string[] = [];
    for (const file of rest.length ? rest : ["-"]) {
      const got = slurp(ctx, file);
      if (got.why) {
        err.push(`${name}: ${file}: ${got.why}`);
        continue;
      }
      const hash = createHash(algorithm).update(got.text, "utf8");
      // The bytes of a big file are not kept: its sum is that of its text and its length, the same every time.
      if (got.file?.pad) hash.update(`\u0000pad:${got.file.pad}`);
      out.push(`${hash.digest("hex")}  ${file}`);
    }
    return result(out, err, err.length ? 1 : 0);
  };

// ---- diff ----------------------------------------------------------------------

type DiffOp = { kind: " " | "-" | "+"; text: string };

function diffLines(a: string[], b: string[], same: (x: string, y: string) => boolean): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && same(a[head], b[head])) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && same(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const middle: DiffOp[] = [];
  if (x.length * y.length > 4_000_000) {
    // Too much to compare line by line: said as one block replaced by another.
    middle.push(...x.map((text) => ({ kind: "-" as const, text })), ...y.map((text) => ({ kind: "+" as const, text })));
  } else {
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) table[i * width + j] = same(x[i], y[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && same(x[i], y[j])) {
        middle.push({ kind: " ", text: x[i] });
        i++;
        j++;
      } else if (i < x.length && (j >= y.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) middle.push({ kind: "-", text: x[i++] });
      else middle.push({ kind: "+", text: y[j++] });
    }
  }
  return [...a.slice(0, head).map((text) => ({ kind: " " as const, text })), ...middle, ...a.slice(a.length - tail).map((text) => ({ kind: " " as const, text }))];
}

const diff: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["U", "unified"]);
  if (flags.has("r") || flags.has("recursive")) throw new NotSimulated("diff -r");
  only("diff", flags, "uqswbiBNa", { unified: "u", brief: "q", "report-identical-files": "s", "ignore-all-space": "w", "ignore-space-change": "b", "ignore-case": "i", "ignore-blank-lines": "B", "new-file": "N", text: "a", color: "" });
  for (const key of values.keys()) if (key !== "U" && key !== "unified" && key !== "color") throw new NotSimulated(`diff --${key}`);
  if (rest.length !== 2) return fail(`diff: missing operand after '${rest[rest.length - 1] ?? "diff"}'\ndiff: Try 'diff --help' for more information.\n`, 2);
  const context = Number(values.get("U") ?? values.get("unified") ?? 3);
  if (!Number.isInteger(context) || context < 0) return fail(`diff: invalid context length '${values.get("U") ?? values.get("unified") ?? ""}'\n`, 2);
  let [left, right] = rest;
  const leftDir = left !== "-" && ctx.host.isDir(abs(ctx, left));
  const rightDir = right !== "-" && ctx.host.isDir(abs(ctx, right));
  if (leftDir && rightDir) throw new NotSimulated("diff of two directories");
  if (leftDir) left = join(left, basename(abs(ctx, right)));
  if (rightDir) right = join(right, basename(abs(ctx, left)));
  const a = slurp(ctx, left);
  const b = slurp(ctx, right);
  const err = [a.why ? `diff: ${left}: ${a.why}` : "", b.why ? `diff: ${right}: ${b.why}` : ""].filter(Boolean);
  if (err.length) return fail(lines(err), 2);
  const key = (line: string): string => {
    let text = line;
    if (flags.has("w")) text = text.replace(/\s+/g, "");
    else if (flags.has("b")) text = text.replace(/\s+/g, " ").replace(/ $/, "");
    return flags.has("i") ? text.toLowerCase() : text;
  };
  const ops = diffLines(textLines(a.text), textLines(b.text), (x, y) => x === y || key(x) === key(y));
  const padded = (a.file?.pad ?? 0) !== (b.file?.pad ?? 0);
  const changed = ops.some((op) => op.kind !== " ") || a.text.endsWith("\n") !== b.text.endsWith("\n");
  if (!changed && !padded) return flags.has("s") ? ok(`Files ${left} and ${right} are identical\n`) : ok();
  if (flags.has("q")) return { out: `Files ${left} and ${right} differ\n`, err: "", code: 1 };
  if (padded && !changed) return { out: `Binary files ${left} and ${right} differ\n`, err: "", code: 1 };
  const now = ctx.host.now();
  const out = [`--- ${left}\t${longDate(a.file?.mtime ?? now)}`, `+++ ${right}\t${longDate(b.file?.mtime ?? now)}`];
  // Each run of changes with the lines around it; runs that touch are one hunk.
  const hunks: [number, number][] = [];
  ops.forEach((op, i) => {
    if (op.kind === " ") return;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = to;
    else hunks.push([from, to]);
  });
  if (!hunks.length) hunks.push([Math.max(0, ops.length - 1), ops.length]);
  const lastOf = (kind: "-" | "+"): number => ops.map((op) => op.kind === " " || op.kind === kind).lastIndexOf(true);
  for (const [from, to] of hunks) {
    const before = ops.slice(0, from);
    const part = ops.slice(from, to);
    const range = (kind: "-" | "+"): string => {
      const start = before.filter((op) => op.kind === " " || op.kind === kind).length;
      const length = part.filter((op) => op.kind === " " || op.kind === kind).length;
      return length === 1 ? String(start + 1) : `${length ? start + 1 : start},${length}`;
    };
    out.push(`@@ -${range("-")} +${range("+")} @@`);
    part.forEach((op, offset) => {
      out.push(`${op.kind}${op.text}`);
      const at = from + offset;
      const unfinished = (op.kind !== "+" && at === lastOf("-") && !a.text.endsWith("\n")) || (op.kind !== "-" && at === lastOf("+") && !b.text.endsWith("\n"));
      if (unfinished && (op.kind !== " " || a.text.endsWith("\n") === b.text.endsWith("\n"))) out.push("\\ No newline at end of file");
    });
  }
  return { out: lines(out), err: "", code: 1 };
};

// ---- test and [ ----------------------------------------------------------------

function testOne(ctx: SimContext, words: string[]): boolean {
  if (words[0] === "!" && words.length > 1) return !testOne(ctx, words.slice(1));
  if (words.length === 0) return false;
  if (words.length === 1) return words[0] !== "";
  if (words.length === 2) {
    const [op, value] = words;
    const path = abs(ctx, value);
    const file = ctx.host.read(path);
    switch (op) {
      case "-z":
        return value === "";
      case "-n":
        return value !== "";
      case "-e":
        return ctx.host.exists(path);
      case "-f":
        return Boolean(file);
      case "-d":
        return ctx.host.isDir(path);
      case "-s":
        return Boolean(file && ctx.host.sizeOf(file) > 0);
      case "-r":
        return ctx.host.exists(path) && ctx.shell.mayRead(path, ctx.root);
      case "-w":
        return ctx.host.exists(path) && ctx.shell.mayWrite(path, ctx.root);
      case "-x":
        return ctx.host.isDir(path) || Boolean(file && file.mode & 0o111 && ctx.shell.mayRead(path, ctx.root));
      case "-L":
      case "-h":
      case "-p":
      case "-S":
      case "-b":
      case "-c":
        return false;
      default:
        throw new Complaint(`${op}: unary operator expected`, 2);
    }
  }
  if (words.length === 3) {
    const [left, op, right] = words;
    if (op === "=" || op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (["-eq", "-ne", "-gt", "-ge", "-lt", "-le"].includes(op)) {
      for (const side of [left, right]) if (!/^\s*[-+]?\d+\s*$/.test(side)) throw new Complaint(`${side}: integer expression expected`, 2);
      const order = Number(left) - Number(right);
      return op === "-eq" ? order === 0 : op === "-ne" ? order !== 0 : op === "-gt" ? order > 0 : op === "-ge" ? order >= 0 : op === "-lt" ? order < 0 : order <= 0;
    }
    if (op === "-nt" || op === "-ot") {
      const a = entryOf(ctx, abs(ctx, left));
      const b = entryOf(ctx, abs(ctx, right));
      if (op === "-nt") return Boolean(a && (!b || a.mtime > b.mtime));
      return Boolean(b && (!a || a.mtime < b.mtime));
    }
    throw new Complaint(`${op}: binary operator expected`, 2);
  }
  throw new Complaint("too many arguments", 2);
}

function splitWords(words: string[], separator: string): string[][] {
  const parts: string[][] = [[]];
  for (const word of words) {
    if (word === separator) parts.push([]);
    else parts[parts.length - 1].push(word);
  }
  return parts;
}

const testAs =
  (name: "test" | "[" | "[["): SimCommand =>
  (ctx, args) => {
    let words = args;
    if (name !== "test") {
      const close = name === "[" ? "]" : "]]";
      if (words[words.length - 1] !== close) return fail(`bash: ${name}: missing \`${close}'\n`, 2);
      words = words.slice(0, -1);
    }
    try {
      // -o binds looser than -a, as in the real one; brackets are not read.
      const truth = words.length <= 3 ? testOne(ctx, words) : splitWords(words, "-o").some((either) => splitWords(either, "-a").every((part) => testOne(ctx, part)));
      return { out: "", err: "", code: truth ? 0 : 1 };
    } catch (error) {
      if (error instanceof Complaint) return fail(`bash: ${name}: ${error.message}\n`, error.code);
      throw error;
    }
  };

// ---- jq, xargs, column ---------------------------------------------------------

function jqEvalExpr(values: unknown[], expr: string): unknown[] {
  const trimmed = expr.trim();
  if (!trimmed || trimmed === ".") return values;
  // Split on top-level pipes `|`, respecting quotes and parentheses.
  const stages: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < trimmed.length) {
        cur += trimmed[++i];
      } else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(" || ch === "[") {
      depth += 1;
      cur += ch;
    } else if (ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "|" && depth === 0) {
      stages.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) stages.push(cur.trim());
  if (stages.length > 1) return stages.reduce((acc, st) => jqEvalExpr(acc, st), values);

  const stage = stages[0];
  if (stage === "length") {
    return values.map((v) => (Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : v === null ? 0 : 1));
  }
  if (stage === "keys" || stage === "keys_unsorted") {
    return values.map((v) => {
      if (Array.isArray(v)) return v.map((_x, i) => i);
      if (v && typeof v === "object") {
        const ks = Object.keys(v);
        return stage === "keys" ? ks.sort() : ks;
      }
      return [];
    });
  }
  if (stage === "type") {
    return values.map((v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v));
  }
  const sel = /^select\(([\s\S]+)\)$/.exec(stage);
  if (sel) {
    const cond = sel[1].trim();
    const cmp = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(cond);
    return values.filter((v) => {
      if (cmp) {
        const left = jqEvalExpr([v], cmp[1].trim())[0];
        const rawRight = cmp[3].trim();
        let right: unknown;
        try {
          right = JSON.parse(rawRight);
        } catch {
          right = jqEvalExpr([v], rawRight)[0];
        }
        if (cmp[2] === "==") return JSON.stringify(left) === JSON.stringify(right);
        if (cmp[2] === "!=") return JSON.stringify(left) !== JSON.stringify(right);
        if (typeof left === "number" && typeof right === "number") {
          if (cmp[2] === ">") return left > right;
          if (cmp[2] === "<") return left < right;
          if (cmp[2] === ">=") return left >= right;
          if (cmp[2] === "<=") return left <= right;
        }
        return false;
      }
      const res = jqEvalExpr([v], cond)[0];
      return Boolean(res);
    });
  }
  // Path navigation: .foo.bar[0][]
  if (stage.startsWith(".")) {
    let acc = values;
    const tokens = stage.slice(1).match(/\[(?:\d+|"[^"]*"|'[^']*')?\]|[^.[\]]+/g) ?? [];
    for (const tok of tokens) {
      if (tok === "[]") {
        acc = acc.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []));
      } else if (/^\[\d+\]$/.test(tok)) {
        const idx = Number(tok.slice(1, -1));
        acc = acc.map((v) => (Array.isArray(v) ? v[idx] ?? null : null));
      } else if (/^\[["'].*["']\]$/.test(tok)) {
        const key = tok.slice(2, -2);
        acc = acc.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[key] ?? null : null));
      } else {
        const key = tok.endsWith("?") ? tok.slice(0, -1) : tok;
        acc = acc.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[key] ?? null : null));
      }
    }
    return acc;
  }
  throw new NotSimulated(`jq filter '${stage}'`);
}

const jq: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args);
  const raw = flags.has("r") || flags.has("raw-output");
  const compact = flags.has("c") || flags.has("compact-output");
  const exitStatus = flags.has("e") || flags.has("exit-status");
  const filter = rest[0] ?? ".";
  const files = rest.slice(1);
  let input = ctx.stdin;
  if (files.length) {
    const parts: string[] = [];
    for (const f of files) {
      const p = abs(ctx, f);
      const file = ctx.host.read(p);
      if (!file) return fail(`jq: error: Could not open file ${f}: No such file or directory\n`, 2);
      if (!ctx.shell.mayRead(p, ctx.root)) return fail(`jq: error: Could not open file ${f}: Permission denied\n`, 2);
      parts.push(file.content);
    }
    input = parts.join("\n");
  }
  const trimmed = input.trim();
  if (!trimmed) return ok();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return fail(`parse error: ${err instanceof Error ? err.message : "Invalid JSON"}\n`, 4);
  }
  const results = jqEvalExpr([parsed], filter);
  const formatted = results.map((v) => {
    if (raw && typeof v === "string") return v;
    return compact ? JSON.stringify(v) : JSON.stringify(v, null, 2);
  });
  const last = results[results.length - 1];
  const code = exitStatus && (results.length === 0 || last === false || last === null) ? 1 : 0;
  return { out: formatted.length ? `${formatted.join("\n")}\n` : "", err: "", code };
};

const xargs: SimCommand = (ctx, args) => {
  let nul = false;
  let noEmpty = false;
  let replaceStr: string | undefined;
  let maxArgs: number | undefined;
  let delimiter: string | undefined;
  let cmdArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      cmdArgs = args.slice(i + 1);
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      cmdArgs = args.slice(i);
      break;
    }
    if (a.startsWith("--")) {
      if (a === "--null") {
        nul = true;
      } else if (a === "--no-run-if-empty") {
        noEmpty = true;
      } else if (a === "--max-args") {
        if (i + 1 < args.length) maxArgs = Math.max(1, Number(args[++i]) || 1);
      } else if (a.startsWith("--max-args=")) {
        maxArgs = Math.max(1, Number(a.slice("--max-args=".length)) || 1);
      } else if (a === "--replace") {
        replaceStr = "{}";
      } else if (a.startsWith("--replace=")) {
        replaceStr = a.slice("--replace=".length) || "{}";
      } else if (a === "--delimiter") {
        if (i + 1 < args.length) delimiter = args[++i];
      } else if (a.startsWith("--delimiter=")) {
        delimiter = a.slice("--delimiter=".length);
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      if (ch === "0") {
        nul = true;
      } else if (ch === "r") {
        noEmpty = true;
      } else if (ch === "I") {
        const inline = a.slice(j + 1);
        if (inline.length > 0) replaceStr = inline;
        else if (i + 1 < args.length) replaceStr = args[++i];
        break;
      } else if (ch === "n") {
        const inline = a.slice(j + 1);
        const val = inline.length > 0 ? inline : i + 1 < args.length ? args[++i] : undefined;
        if (val !== undefined) maxArgs = Math.max(1, Number(val) || 1);
        break;
      } else if (ch === "d") {
        const inline = a.slice(j + 1);
        if (inline.length > 0) delimiter = inline;
        else if (i + 1 < args.length) delimiter = args[++i];
        break;
      }
    }
  }

  const unescapeDelim = (d: string): string =>
    d === "\\n" ? "\n" : d === "\\t" ? "\t" : d === "\\0" ? "\u0000" : d;
  const rawItems = nul
    ? ctx.stdin.split("\u0000").filter((s) => s.length > 0)
    : delimiter !== undefined && delimiter.length > 0
      ? ctx.stdin.split(unescapeDelim(delimiter)).filter((s) => s.length > 0)
      : ctx.stdin.trim().split(/\s+/).filter(Boolean);
  if (!rawItems.length && noEmpty) return ok();
  const baseCmd = cmdArgs.length ? cmdArgs : ["echo"];
  const quoteArg = (s: string): string => (/[\s"'$`\\|&;<>()[\]*?~]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  let out = "";
  let err = "";
  let code = 0;
  if (replaceStr !== undefined) {
    for (const item of rawItems) {
      const cmdLine = baseCmd.map((tok) => (tok.includes(replaceStr) ? quoteArg(tok.split(replaceStr).join(item)) : quoteArg(tok))).join(" ");
      const res = ctx.shell.exec(cmdLine, { root: ctx.root, stdin: "" });
      out += res.out;
      err += res.err;
      if (res.code !== 0) code = res.code;
    }
    return { out, err, code };
  }
  const batches: string[][] = [];
  if (!rawItems.length) {
    batches.push([]);
  } else if (maxArgs) {
    for (let i = 0; i < rawItems.length; i += maxArgs) batches.push(rawItems.slice(i, i + maxArgs));
  } else {
    batches.push(rawItems);
  }
  for (const batch of batches) {
    const cmdLine = [...baseCmd, ...batch].map(quoteArg).join(" ");
    const res = ctx.shell.exec(cmdLine, { root: ctx.root, stdin: "" });
    out += res.out;
    err += res.err;
    if (res.code !== 0) code = res.code;
  }
  return { out, err, code };
};

const column: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["s", "o"]);
  const sep = values.get("s");
  const outSep = values.get("o") ?? "  ";
  let text = ctx.stdin;
  if (rest.length) {
    const parts: string[] = [];
    for (const f of rest) {
      const p = abs(ctx, f);
      const file = ctx.host.read(p);
      if (!file) return fail(`column: cannot open ${f}: No such file or directory\n`, 1);
      parts.push(file.content);
    }
    text = parts.join("\n");
  }
  const rawLines = text.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  if (!flags.has("t")) return ok(lines(rawLines));
  const splitRow = (line: string): string[] => {
    if (sep) return line.split(new RegExp(`[${sep.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}]`));
    return line.trim().split(/\s+/);
  };
  const rows = rawLines.map(splitRow);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return ok(lines(rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join(outSep))));
};

// ---- the table -----------------------------------------------------------------

export const fileCommands: Record<string, SimCommand> = {
  echo,
  printf,
  true: () => ok(),
  false: () => ({ out: "", err: "", code: 1 }),
  pwd: (ctx) => ok(`${ctx.cwd}\n`),
  ls,
  cat,
  less: pager("less"),
  more: pager("more"),
  head: headOrTail("head"),
  tail: headOrTail("tail"),
  grep: grepAs("grep", ""),
  egrep: grepAs("grep", "E"),
  fgrep: grepAs("grep", "F"),
  wc,
  sort,
  uniq,
  cut,
  tr,
  awk,
  gawk: awk,
  mawk: awk,
  sed,
  find,
  du,
  stat,
  file: fileType,
  touch,
  mkdir,
  rmdir,
  rm,
  mv,
  cp,
  ln,
  tee,
  chmod: change("chmod"),
  chown: change("chown"),
  chgrp: change("chgrp"),
  basename: basenameCommand,
  dirname: dirnameCommand,
  realpath,
  readlink,
  md5sum: checksum("md5sum", "md5"),
  sha1sum: checksum("sha1sum", "sha1"),
  sha256sum: checksum("sha256sum", "sha256"),
  sha512sum: checksum("sha512sum", "sha512"),
  diff,
  jq,
  xargs,
  column,
  test: testAs("test"),
  "[": testAs("["),
  "[[": testAs("[["),
  nano: editor("nano"),
  vi: editor("vi"),
  vim: editor("vim"),
};
