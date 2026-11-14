import type {
  AgentMode,
  CommandRiskLevel,
  SafetyPolicyConfig,
} from "../../../shared/types/aiHub";

/**
 * How risky a shell command is: read-only ("safe"), changes state ("modify"),
 * or hard to take back ("destructive").
 *
 * This is not a shell. It reads a command the way a careful reviewer would,
 * and when it is not sure, it says "modify" — the safe direction, since
 * "modify" is asked about in assisted mode and only "safe" ever runs unasked
 * there. Three rules carry it:
 *
 * 1. Split on every way a shell runs one thing after another — `;`, newline,
 *    `&&`, `||`, `|`, `|&` and a single `&` — and look into everything that
 *    runs inside: `$(…)`, backticks, `<(…)`, `bash -c '…'`, `eval`, `find
 *    -exec …`, `xargs …`. Quotes, including `$'…'`, are followed, so a `;`
 *    inside a quoted string does not split and one outside it always does.
 * 2. Judge the program that actually runs, after the words in front of it
 *    that only run something else (`sudo`, `env`, `timeout`, `nice`, `nohup`,
 *    `xargs`, assignments like `FOO=1`), on its own arguments — never on the
 *    raw text, so `grep reboot /var/log/syslog` is a search, not a reboot.
 * 3. Read-only is a list of known forms, each with the flags that would make
 *    it write excluded. Anything not on the list is "modify". A write to a
 *    file with `>`, `>>`, `2>` or `&>` is "modify" whatever the program is.
 */

export interface CommandRiskAnalysis {
  riskLevel: CommandRiskLevel;
  riskReason: string;
  parsedSubcommands: string[];
}

export const DEFAULT_SAFETY_POLICY: SafetyPolicyConfig = {
  autoApproveSafeReadOnly: true,
  requireApprovalOnProdTags: true,
  blockDestructiveWithoutConfirm: true,
};

/** Nested deeper than this, a command is not read further: it is treated as unknown, never as safe. */
const MAX_DEPTH = 6;
const TOO_DEEP = "\u0000too-deep";

/** Reads to the bracket that closes the one at `start` (which is just past an opening `(`). Quotes are followed. */
function closeParen(text: string, start: number): number {
  let depth = 1;
  let single = false;
  let double = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === "\\" && !single) {
      j++;
      continue;
    }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (!single && !double) {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
    }
  }
  return text.length;
}

/** Which of a line's commands read from the command before them (`a | b`), and which are also written without one. */
interface PipeUse {
  fed: Set<string>;
  bare: Set<string>;
}

/**
 * The simple commands a command line is made of, as written, plus everything
 * that runs inside them (substitutions), each as a command of its own.
 */
export function splitShellAstSegments(command: string, depth = 0, pipes?: PipeUse): string[] {
  const text = (command ?? "").trim();
  if (!text) return [];
  if (depth > MAX_DEPTH) return [TOO_DEEP];
  const segments: string[] = [];
  const inner: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let afterPipe = false;
  const cut = (): void => {
    if (current.trim()) {
      segments.push(current.trim());
      (afterPipe ? pipes?.fed : pipes?.bare)?.add(current.trim());
    }
    current = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && !single) {
      current += ch + (next ?? "");
      i++;
      continue;
    }
    if (single) {
      if (ch === "'") single = false;
      current += ch;
      continue;
    }
    // ANSI-C quoting: $'…' with backslash escapes, closed by an unescaped quote.
    if (ch === "$" && next === "'" && !double) {
      let j = i + 2;
      while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "'" && !double) {
      single = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      double = !double;
      current += ch;
      continue;
    }
    // Arithmetic $(( … )) runs nothing, unless a substitution hides inside it.
    if (ch === "$" && next === "(" && text[i + 2] === "(") {
      const end = closeParen(text, i + 2);
      const body = text.slice(i + 3, end);
      if (/\$\(|`/.test(body)) inner.push(body);
      current += text.slice(i, end + 2);
      i = end + 1;
      continue;
    }
    // $( … ), and outside double quotes <( … ) and >( … ).
    if (next === "(" && (ch === "$" || (!double && (ch === "<" || ch === ">")))) {
      const end = closeParen(text, i + 2);
      inner.push(text.slice(i + 2, end));
      current += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      inner.push(text.slice(i + 1, j));
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (!double) {
      if ((ch === "&" && next === "&") || (ch === "|" && (next === "|" || next === "&"))) {
        cut();
        afterPipe = ch === "|" && next === "&";
        i++;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
        cut();
        afterPipe = ch === "|";
        continue;
      }
      // A single & sends what came before to the background and goes on: a separator.
      // Not when it belongs to a redirection: &>, >&, <&.
      if (ch === "&" && next !== ">" && text[i - 1] !== ">" && text[i - 1] !== "<") {
        cut();
        afterPipe = false;
        continue;
      }
    }
    current += ch;
  }
  cut();
  for (const sub of inner)
    for (const child of splitShellAstSegments(sub, depth + 1)) if (!segments.includes(child)) segments.push(child);
  return segments;
}

interface Word {
  /** The word with its quotes taken away. */
  text: string;
  /** Some of it was quoted: it cannot be an operator. */
  quoted: boolean;
}

/** The words of one simple command, quotes resolved. */
function shellWords(segment: string): Word[] {
  const out: Word[] = [];
  let text = "";
  let quoted = false;
  let started = false;
  const push = (): void => {
    if (started) out.push({ text, quoted });
    text = "";
    quoted = false;
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    started = true;
    if (ch === "\\") {
      text += segment[i + 1] ?? "";
      i++;
    } else if (ch === "$" && segment[i + 1] === "'") {
      let j = i + 2;
      while (j < segment.length && segment[j] !== "'") {
        text += segment[j] === "\\" ? segment[++j] ?? "" : segment[j];
        j++;
      }
      quoted = true;
      i = j;
    } else if (ch === "'" || ch === '"') {
      const end = segment.indexOf(ch, i + 1);
      const stop = end < 0 ? segment.length : end;
      text += segment.slice(i + 1, stop);
      quoted = true;
      i = stop;
    } else if (ch === "$" && segment[i + 1] === "(") {
      const end = closeParen(segment, i + 2);
      text += segment.slice(i, end + 1);
      i = end;
    } else text += ch;
  }
  push();
  return out;
}

/** Where output may go without anything being written. */
const HARMLESS_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|&-?\d*|-)$/;

/** Takes the redirections out of a command's words, and says whether any of them writes a file. */
function withoutRedirections(words: Word[]): { words: Word[]; writes?: string } {
  const out: Word[] = [];
  let writes: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const op = w.quoted ? null : /^(\d*|&)(>>?\|?|>&|<<<|<<-?|<&|<>|<)(.*)$/.exec(w.text);
    if (!op) {
      out.push(w);
      continue;
    }
    let target = op[3];
    if (!target && i + 1 < words.length) target = words[++i].text;
    const kind = op[2];
    if (kind.startsWith(">") || kind === "<>")
      if (!HARMLESS_TARGET.test(kind === ">&" ? `&${target}` : target)) writes = target || "a file";
  }
  return { words: out, writes };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);

interface Judgement {
  level: CommandRiskLevel;
  reason: string;
}
const SAFE = (reason = "Matches the read-only list"): Judgement => ({ level: "safe", reason });
const MODIFY = (reason: string): Judgement => ({ level: "modify", reason });
const DESTROY = (reason: string): Judgement => ({ level: "destructive", reason });
const RANK: CommandRiskLevel[] = ["safe", "modify", "destructive"];
const worse = (a: Judgement, b: Judgement): Judgement => (RANK.indexOf(b.level) > RANK.indexOf(a.level) ? b : a);

/** Options of a wrapper that take a value as the next word. */
const WRAPPER_ARGS: Record<string, RegExp> = {
  sudo: /^-[ughpCDrtUT]$/,
  doas: /^-[uC]$/,
  env: /^-[uCS]$/,
  timeout: /^-[sk]$/,
  nice: /^-n$/,
  ionice: /^-[cnt]$/,
  stdbuf: /^-[ioe]$/,
  xargs: /^-[nLIdEPsa]$/,
  watch: /^-[nqd]$/,
  time: /^-[fo]$/,
};
const WRAPPERS = new Set([...Object.keys(WRAPPER_ARGS), "nohup", "command", "exec", "builtin"]);

/** What `sudo -i`, `sudo -s` and `doas -s` leave in `wrappers`: with no command after them they are a shell as another user. */
const SHELL_AS = "shell as another user: ";

/**
 * Variables that decide what code a program loads or runs, or where it finds its settings:
 * `LD_PRELOAD=/tmp/x.so ls` is not `ls`. Setting one is a change, whatever the command after it.
 */
const LOADS_CODE =
  /^(LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|IFS|ENV|BASH_ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|HOME|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PYTHONINSPECT|PERL5LIB|PERLLIB|PERL5OPT|PERL5DB|RUBYOPT|RUBYLIB|NODE_OPTIONS|NODE_PATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|GIT_EXEC_PATH|GIT_ASKPASS|GIT_CONFIG[A-Z0-9_]*|GIT_PROXY_COMMAND|SSH_ASKPASS|SUDO_ASKPASS|LESSOPEN|LESSCLOSE|GCONV_PATH|LOCPATH|NLSPATH|HOSTALIASES|RESOLV_HOST_CONF|CURL_HOME|WGETRC|INPUTRC|TERMINFO|TERMINFO_DIRS)$/;
/** A pager or an editor is run by the program: harmless only when it is one that just shows the text, or none. */
const RUNS_AS_HELPER = /^([A-Z0-9_]*PAGER|EDITOR|VISUAL|[A-Z0-9_]*_EDITOR|BROWSER)$/;
const SYSTEM_PATH = /^(\$PATH|\$\{PATH\}|\/usr\/local\/s?bin|\/usr\/s?bin|\/s?bin|\/snap\/bin)\/?$/;
const PLAIN_PAGER = /^(|cat|less|more|\/bin\/cat|\/usr\/bin\/cat|\/usr\/bin\/less)$/;

/** The name of a variable an assignment sets, when setting it changes what the command loads or runs. */
function riskyAssignment(word: string): string | undefined {
  const at = word.indexOf("=");
  const name = word.slice(0, at);
  if (LOADS_CODE.test(name)) return name;
  // PATH with the system's own directories added (PATH=$PATH:/usr/sbin ip a) finds the same programs; anything else may not.
  if (name === "PATH" && !word.slice(at + 1).split(":").every((dir) => SYSTEM_PATH.test(dir))) return name;
  if (RUNS_AS_HELPER.test(name) && !PLAIN_PAGER.test(word.slice(at + 1).trim())) return name;
  return undefined;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Takes away what only runs something else, and returns what runs. `wrappers`
 * collects what was taken away, for what it adds of its own (`watch` never ends),
 * and `assigned` the variables that were set in front of the command (FOO=bar cmd, env FOO=bar cmd).
 */
function unwrap(words: string[], wrappers: string[], assigned: string[] = []): string[] {
  let w = [...words];
  for (let guard = 0; guard < 20 && w.length; guard++) {
    // Leading assignments: FOO=bar cmd.
    while (w.length && ASSIGNMENT.test(w[0])) {
      assigned.push(w[0]);
      w = w.slice(1);
    }
    const verb = (w[0] ?? "").replace(/^.*\//, "");
    if (!WRAPPERS.has(verb)) break;
    if (verb === "command" && /^-[vV]/.test(w[1] ?? "")) break;
    wrappers.push(verb);
    let i = 1;
    while (i < w.length && w[i].startsWith("-") && w[i] !== "--") {
      if (verb === "env" && (w[i] === "-S" || w[i].startsWith("--split-string"))) {
        // env -S 'a b c': the string is split into the command.
        const rest = w[i].includes("=") ? w[i].split("=").slice(1).join("=") : w[i + 1] ?? "";
        return unwrap([...rest.split(/\s+/).filter(Boolean), ...w.slice(w[i].includes("=") ? i + 1 : i + 2)], wrappers, assigned);
      }
      // sudo -i, sudo -s (also inside a group: -is, -iu root) and doas -s start a shell.
      if (
        (verb === "sudo" && (/^-[a-zA-Z]*[is]/.test(w[i]) || w[i] === "--login" || w[i] === "--shell")) ||
        (verb === "doas" && /^-[a-zA-Z]*s/.test(w[i]))
      )
        wrappers.push(`${SHELL_AS}${verb} ${w[i]}`);
      i += WRAPPER_ARGS[verb]?.test(w[i]) ? 2 : 1;
    }
    if (w[i] === "--") i++;
    // sudo takes assignments too (sudo LD_PRELOAD=x cmd), like env.
    if (verb === "env" || verb === "sudo" || verb === "doas")
      while (i < w.length && ASSIGNMENT.test(w[i])) assigned.push(w[i++]);
    if (verb === "timeout" && i < w.length) i++; // the duration
    w = w.slice(i);
  }
  return w;
}

const has = (args: string[], ...flags: RegExp[]): boolean => args.some((a) => flags.some((f) => f.test(a)));
/** A short flag letter anywhere in a group like -rvf, or its long form. */
const flag = (args: string[], letter: string, long?: string): boolean =>
  args.some((a) => (/^-[a-zA-Z]+$/.test(a) && a.slice(1).includes(letter)) || (long !== undefined && (a === long || a.startsWith(`${long}=`))));
const positional = (args: string[]): string[] => args.filter((a) => !a.startsWith("-"));

const NEVER_ENDS = "Never ends by itself (follows or waits for a person)";

/** The rules for one program, given its arguments. Undefined: not known, so "modify". */
const RULES: Record<string, (args: string[], all: string) => Judgement | undefined> = {
  rm: (a) =>
    flag(a, "r", "--recursive") || flag(a, "R")
      ? DESTROY("Recursive file deletion (rm -r)")
      : MODIFY("Deletes files"),
  shred: () => DESTROY("Overwrites files so they cannot be recovered"),
  dd: (a) => (a.some((x) => x.startsWith("of=")) ? DESTROY("Writes raw data over a file or device (dd of=)") : MODIFY("dd")),
  mkfs: () => DESTROY("Creates a file system, erasing what was there"),
  mke2fs: () => DESTROY("Creates a file system, erasing what was there"),
  mkswap: () => DESTROY("Formats a device as swap"),
  wipefs: () => DESTROY("Wipes file system signatures"),
  blkdiscard: () => DESTROY("Discards every block of a device"),
  fdisk: (a) => (flag(a, "l", "--list") ? SAFE() : DESTROY("Edits a partition table")),
  sfdisk: (a) => (flag(a, "l", "--list") || has(a, /^-d$/, /^--dump$/) ? SAFE() : DESTROY("Edits a partition table")),
  gdisk: () => DESTROY("Edits a partition table"),
  sgdisk: (a) => (has(a, /^-p$/, /^--print$/) ? SAFE() : DESTROY("Edits a partition table")),
  parted: (a) => (flag(a, "l", "--list") || a.includes("print") ? SAFE() : DESTROY("Edits a partition table")),
  cryptsetup: (a) => (a.some((x) => /^(luksErase|erase|luksKillSlot|luksFormat)$/.test(x)) ? DESTROY("Erases encryption keys or formats a device") : a[0] && /^(status|luksDump|isLuks)$/.test(a[0]) ? SAFE() : MODIFY("Changes disk encryption")),
  lvremove: () => DESTROY("Removes a logical volume"),
  vgremove: () => DESTROY("Removes a volume group"),
  pvremove: () => DESTROY("Removes a physical volume"),
  mdadm: (a) => (has(a, /^--zero-superblock$/, /^--stop$/, /^-S$/) ? DESTROY("Stops or erases a RAID array") : has(a, /^--detail$/, /^-D$/, /^--examine$/, /^-E$/, /^--query$/, /^-Q$/) ? SAFE() : MODIFY("Changes a RAID array")),
  zpool: (a) => (a[0] === "destroy" || a[0] === "labelclear" ? DESTROY("Destroys a ZFS pool") : ["status", "list", "iostat", "history", "get"].includes(a[0] ?? "") ? SAFE() : MODIFY("Changes a ZFS pool")),
  zfs: (a) => (a[0] === "destroy" || a[0] === "rollback" ? DESTROY("Destroys a ZFS dataset or rolls it back") : ["list", "get"].includes(a[0] ?? "") ? SAFE() : MODIFY("Changes a ZFS dataset")),
  ceph: (a, all) =>
    /\b(osd\s+(purge|destroy|rm)|mon\s+remove|fs\s+(rm|fail)|osd\s+pool\s+(delete|rm))\b/.test(all)
      ? DESTROY("Removes a Ceph OSD, monitor, pool or file system")
      : /^(status|-s|health|df|versions|quorum_status)$/.test(a[0] ?? "") || /^(osd\s+(tree|df|stat|perf|pool\s+(stats|ls))|pg\s+stat|mon\s+stat|osd\s+ls)\b/.test(all)
        ? SAFE()
        : MODIFY("Changes the Ceph cluster"),
  kubectl: (a) => kubectl(a),
  helm: (a) =>
    ["uninstall", "delete", "del"].includes(a[0] ?? "")
      ? DESTROY("Removes a Helm release")
      : ["list", "ls", "status", "get", "history", "show", "search", "version", "template", "lint", "env"].includes(a[0] ?? "")
        ? SAFE()
        : MODIFY("Changes a Helm release"),
  shutdown: () => DESTROY("Shuts the system down or reboots it"),
  reboot: () => DESTROY("Reboots the system"),
  poweroff: () => DESTROY("Powers the system off"),
  halt: () => DESTROY("Halts the system"),
  init: (a) => (/^[06]$/.test(a[0] ?? "") ? DESTROY("Halts or reboots the system") : MODIFY("Changes the run level")),
  telinit: () => DESTROY("Changes the run level"),
  systemctl: (a) => systemctl(a),
  service: (a) => (a[1] === "status" ? SAFE() : MODIFY("Starts, stops or restarts a service")),
  iptables: (a) => iptables(a),
  ip6tables: (a) => iptables(a),
  nft: (a) => (a[0] === "flush" || (a[0] === "delete" && a[1] === "table") ? DESTROY("Removes firewall rules") : a[0] === "list" ? SAFE() : MODIFY("Changes the firewall")),
  ufw: (a) => (["reset", "disable"].includes(a[0] ?? "") ? DESTROY("Resets or turns off the firewall") : a[0] === "status" ? SAFE() : MODIFY("Changes the firewall")),
  "firewall-cmd": (a) => (has(a, /^--panic-on$/, /^--complete-reload$/) ? DESTROY("Drops all traffic or reloads the firewall") : a.every((x) => /^--(list|get|query|state)/.test(x) || x.startsWith("--zone")) && a.length > 0 ? SAFE() : MODIFY("Changes the firewall")),
  chmod: (a) =>
    flag(a, "R", "--recursive") && positional(a).slice(1).some((p) => p.startsWith("/"))
      ? DESTROY("Changes permissions of a whole tree")
      : positional(a)[0] === "777" && positional(a).slice(1).some((p) => /^\/(etc|var|usr|boot|root|bin|sbin|lib)?\/?$/.test(p))
        ? DESTROY("Opens a system directory to everyone")
        : MODIFY("Changes permissions"),
  chown: (a) => (flag(a, "R", "--recursive") && positional(a).slice(1).some((p) => p.startsWith("/")) ? DESTROY("Changes the owner of a whole tree") : MODIFY("Changes ownership")),
  chgrp: (a) => (flag(a, "R", "--recursive") && positional(a).slice(1).some((p) => p.startsWith("/")) ? DESTROY("Changes the group of a whole tree") : MODIFY("Changes ownership")),
  crontab: (a) => (flag(a, "r") ? DESTROY("Removes every cron job of the user") : flag(a, "l") ? SAFE() : MODIFY("Changes cron jobs")),
  userdel: () => DESTROY("Deletes a user"),
  deluser: () => DESTROY("Deletes a user"),
  groupdel: () => DESTROY("Deletes a group"),
  passwd: (a) => (flag(a, "S", "--status") ? SAFE() : MODIFY("Changes a password or locks an account")),
  kill: (a) => (positional(a).some((p) => p === "1" || p === "-1") ? DESTROY("Signals process 1 or every process") : MODIFY("Signals a process")),
  pkill: () => MODIFY("Signals processes by name"),
  killall: () => MODIFY("Signals processes by name"),
  dropdb: () => DESTROY("Drops a database"),
  terraform: (a) =>
    a[0] === "destroy" || (a[0] === "apply" && a.includes("-destroy"))
      ? DESTROY("Destroys infrastructure")
      : ["plan", "show", "output", "validate", "version", "fmt", "providers", "graph", "state"].includes(a[0] ?? "") && !(a[0] === "state" && /^(rm|mv|push|replace-provider)$/.test(a[1] ?? "")) && !(a[0] === "fmt" && !a.includes("-check"))
        ? SAFE()
        : MODIFY("Changes infrastructure"),
  aws: (a, all) =>
    /^s3 rb\b/.test(all) || (/^s3 rm\b/.test(all) && a.includes("--recursive")) || /\bdelete-(bucket|db-instance|db-cluster|stack|table|cluster)\b/.test(all) || /\bterminate-instances\b/.test(all)
      ? DESTROY("Removes cloud resources")
      : /^(s3 ls|sts get-caller-identity)\b/.test(all) || a.some((x) => /^(describe|list|get)-/.test(x))
        ? SAFE()
        : MODIFY("Changes cloud resources"),
  gsutil: (a) => (a[0] === "rb" || (a[0] === "rm" && flag(a, "r")) ? DESTROY("Removes a bucket or a tree of objects") : ["ls", "du", "cat", "stat"].includes(a[0] ?? "") ? SAFE() : MODIFY("Changes cloud storage")),
  s3cmd: (a) => (a[0] === "rb" || (a[0] === "del" && flag(a, "r", "--recursive")) ? DESTROY("Removes a bucket or a tree of objects") : ["ls", "la", "du", "info"].includes(a[0] ?? "") ? SAFE() : MODIFY("Changes object storage")),
  mc: (a) => (a[0] === "rb" || (a[0] === "rm" && has(a, /^--recursive$/, /^-r$/)) ? DESTROY("Removes a bucket or a tree of objects") : ["ls", "du", "cat", "stat", "tree"].includes(a[0] ?? "") ? SAFE() : MODIFY("Changes object storage")),
  rsync: (a) => (a.some((x) => x.startsWith("--delete") || x === "--remove-source-files") ? DESTROY("Deletes files that are not in the source") : has(a, /^--dry-run$/, /^-n$/) || flag(a, "n") ? SAFE() : MODIFY("Copies files")),
  docker: (a) => containers(a),
  podman: (a) => containers(a),
  nerdctl: (a) => containers(a),
  "redis-cli": (a) => redis(a),
  // Database clients: what they run is in the arguments or on stdin.
  psql: (_a, all) => sql(all),
  mysql: (_a, all) => sql(all),
  mariadb: (_a, all) => sql(all),
  sqlite3: (_a, all) => sql(all),
  "clickhouse-client": (_a, all) => sql(all),
  cqlsh: (_a, all) => sql(all),
  mongosh: (_a, all) => (/\.(drop|dropDatabase|deleteMany|remove)\(/.test(all) ? DESTROY("Drops or deletes data") : MODIFY("Runs database commands")),

  // Read-only programs, with the forms that would make them write excluded.
  ls: () => SAFE(),
  df: () => SAFE(),
  du: () => SAFE(),
  free: () => SAFE(),
  uptime: () => SAFE(),
  uname: () => SAFE(),
  whoami: () => SAFE(),
  id: () => SAFE(),
  groups: () => SAFE(),
  pwd: () => SAFE(),
  printenv: () => SAFE(),
  lscpu: () => SAFE(),
  lsblk: () => SAFE(),
  lspci: () => SAFE(),
  lsusb: () => SAFE(),
  lsmod: () => SAFE(),
  lsof: () => SAFE(),
  stat: () => SAFE(),
  file: () => SAFE(),
  wc: () => SAFE(),
  head: () => SAFE(),
  cat: () => SAFE(),
  tac: () => SAFE(),
  nl: () => SAFE(),
  grep: () => SAFE(),
  egrep: () => SAFE(),
  fgrep: () => SAFE(),
  zgrep: () => SAFE(),
  zcat: () => SAFE(),
  rg: () => SAFE(),
  cut: () => SAFE(),
  tr: () => SAFE(),
  column: () => SAFE(),
  jq: () => SAFE(),
  yq: (a) => (flag(a, "i", "--inplace") ? MODIFY("Edits a file in place") : SAFE()),
  md5sum: () => SAFE(),
  sha1sum: () => SAFE(),
  sha256sum: () => SAFE(),
  basename: () => SAFE(),
  dirname: () => SAFE(),
  realpath: () => SAFE(),
  readlink: () => SAFE(),
  nproc: () => SAFE(),
  getent: () => SAFE(),
  w: () => SAFE(),
  who: () => SAFE(),
  last: () => SAFE(),
  tty: () => SAFE(),
  locale: () => SAFE(),
  diff: () => SAFE(),
  cmp: () => SAFE(),
  seq: () => SAFE(),
  sleep: () => SAFE(),
  echo: () => SAFE(),
  printf: (a) => (a[0] === "-v" ? MODIFY("Sets a variable") : SAFE()),
  true: () => SAFE(),
  false: () => SAFE(),
  test: () => SAFE(),
  "[": () => SAFE(),
  "[[": () => SAFE(),
  which: () => SAFE(),
  command: (a) => (/^-[vV]$/.test(a[0] ?? "") ? SAFE() : undefined),
  type: () => SAFE(),
  whereis: () => SAFE(),
  env: (a) => (a.length === 0 ? SAFE() : undefined),
  ps: () => SAFE(),
  pgrep: () => SAFE(),
  pstree: () => SAFE(),
  vmstat: () => SAFE(),
  iostat: () => SAFE(),
  mpstat: () => SAFE(),
  sar: () => SAFE(),
  pidstat: () => SAFE(),
  numastat: () => SAFE(),
  journalctl: (a) =>
    a.some((x) => /^--(vacuum-|rotate|flush|sync|relinquish-var|setup-keys)/.test(x))
      ? MODIFY("Removes or rotates logs")
      : flag(a, "f", "--follow")
        ? MODIFY(NEVER_ENDS)
        : SAFE(),
  dmesg: (a) => (flag(a, "c", "--read-clear") || flag(a, "C", "--clear") || flag(a, "D") || flag(a, "E") || flag(a, "n", "--console-level") ? MODIFY("Clears or changes the kernel log") : flag(a, "w", "--follow") || has(a, /^--follow/) ? MODIFY(NEVER_ENDS) : SAFE()),
  tail: (a) => (flag(a, "f", "--follow") || flag(a, "F") ? MODIFY(NEVER_ENDS) : SAFE()),
  less: () => MODIFY(NEVER_ENDS),
  more: () => MODIFY(NEVER_ENDS),
  top: (a) => (flag(a, "b") && a.some((x, i) => x === "-n" || /^-[a-zA-Z]*n\d*$/.test(x) || a[i - 1] === "-n") ? SAFE() : MODIFY(NEVER_ENDS)),
  htop: () => MODIFY(NEVER_ENDS),
  sort: (a) => (flag(a, "o", "--output") || a.some((x) => /^-[a-zA-Z]*o./.test(x)) ? MODIFY("Writes its output to a file") : SAFE()),
  uniq: (a) => (positional(a).length > 1 ? MODIFY("Writes its output to a file") : SAFE()),
  sed: (a) => sed(a),
  awk: (a) => awk(a),
  gawk: (a) => awk(a),
  mawk: (a) => awk(a),
  find: (a) => find(a),
  date: (a) => date(a),
  hostname: (a) => (positional(a).length > 0 || flag(a, "F", "--file") || flag(a, "b", "--boot") ? MODIFY("Sets the host name") : SAFE()),
  hostnamectl: (a) => (!a[0] || a[0] === "status" ? SAFE() : MODIFY("Changes the host name")),
  timedatectl: (a) => (!a[0] || ["status", "show", "list-timezones", "timesync-status", "show-timesync"].includes(a[0]) ? SAFE() : MODIFY("Changes time settings")),
  ip: (a) => ip(a),
  ss: (a) => (flag(a, "K", "--kill") ? MODIFY("Closes connections") : SAFE()),
  netstat: () => SAFE(),
  ping: (a) => (flag(a, "c", "--count") || a.some((x) => /^-[a-zA-Z]*c\d+$/.test(x)) ? SAFE() : MODIFY(NEVER_ENDS)),
  ping6: (a) => (flag(a, "c") ? SAFE() : MODIFY(NEVER_ENDS)),
  traceroute: () => SAFE(),
  tracepath: () => SAFE(),
  mtr: (a) => (flag(a, "r", "--report") || flag(a, "w") ? SAFE() : MODIFY(NEVER_ENDS)),
  dig: () => SAFE(),
  nslookup: () => SAFE(),
  host: () => SAFE(),
  whois: () => SAFE(),
  ethtool: (a) => (a.length <= 1 || /^-(i|S|k|g|a|c|l|m|P|T|d|e|n|u|t|-show|-driver|-statistics|-module-info)/.test(a[0]) && !/^-[sKGACLEf]$/.test(a[0]) ? SAFE() : MODIFY("Changes a network interface")),
  multipath: (a) => (flag(a, "l") ? SAFE() : MODIFY("Changes multipath devices")),
  iscsiadm: (a) => (a.includes("session") && !has(a, /^--(logout|login|op)/, /^-[uloU]$/) ? SAFE() : MODIFY("Changes iSCSI sessions")),
  openssl: (a) => (/^(x509|verify|version|s_client|req|crl|rsa|ec|pkey|asn1parse|ciphers)$/.test(a[0] ?? "") && !has(a, /^-out$/, /^-keyout$/, /^-new$/, /^-genkey/) ? SAFE() : MODIFY("Makes keys or certificates")),
  "pg_isready": () => SAFE(),
  mysqladmin: (a) => (["ping", "status", "version", "processlist", "variables", "extended-status"].includes(a.filter((x) => !x.startsWith("-"))[0] ?? "") ? SAFE() : MODIFY("Changes the MySQL server")),
  nginx: (a) => (a.length > 0 && a.every((x) => /^-[tTvV]+$/.test(x)) ? SAFE() : MODIFY("Starts or signals nginx")),
  apachectl: (a) => (["-t", "configtest", "-v", "-V", "-S", "-M"].includes(a[0] ?? "") ? SAFE() : MODIFY("Starts or signals Apache")),
  apache2ctl: (a) => (["-t", "configtest", "-v", "-V", "-S", "-M"].includes(a[0] ?? "") ? SAFE() : MODIFY("Starts or signals Apache")),
  sshd: (a) => (a.length > 0 && a.every((x) => /^-[tT]$/.test(x)) ? SAFE() : MODIFY("Starts sshd")),
  haproxy: (a) => (flag(a, "c") ? SAFE() : MODIFY("Starts haproxy")),
  "named-checkconf": () => SAFE(),
  "named-checkzone": () => SAFE(),
  visudo: (a) => (flag(a, "c", "--check") ? SAFE() : MODIFY("Edits sudoers")),
  "dpkg-query": () => SAFE(),
  dpkg: (a) => (/^(-l|-s|-L|-S|--list|--status|--listfiles|--search|--print-architecture)$/.test(a[0] ?? "") ? SAFE() : MODIFY("Installs or removes packages")),
  rpm: (a) => (/^-q[a-zA-Z]*$/.test(a[0] ?? "") || a[0] === "--query" ? SAFE() : MODIFY("Installs or removes packages")),
  apk: (a) => (["info", "list", "version", "search", "policy"].includes(a[0] ?? "") ? SAFE() : MODIFY("Installs or removes packages")),
  apt: (a) => (["list", "show", "search", "policy", "depends", "rdepends"].includes(a[0] ?? "") ? SAFE() : MODIFY("Package manager operation")),
  "apt-cache": () => SAFE(),
  pip: (a) => (["list", "show", "freeze", "check"].includes(a[0] ?? "") ? SAFE() : MODIFY("Installs or removes Python packages")),
  pip3: (a) => (["list", "show", "freeze", "check"].includes(a[0] ?? "") ? SAFE() : MODIFY("Installs or removes Python packages")),
  snap: (a) => (["list", "info", "version", "services"].includes(a[0] ?? "") ? SAFE() : MODIFY("Installs or removes snaps")),
  git: (a) => (["status", "log", "diff", "show", "rev-parse", "describe", "ls-files", "blame", "shortlog", "reflog", "grep", "ls-remote"].includes(a[0] ?? "") || (a[0] === "remote" && (a.length === 1 || a[1] === "-v" || a[1] === "show")) || (a[0] === "branch" && a.slice(1).every((x) => /^(-a|-r|-v|-vv|--list|--all|--remotes|--show-current)$/.test(x))) ? SAFE() : MODIFY("Changes a git repository")),
  curl: (a) => (readOnlyCurl(a) ? SAFE() : MODIFY("Sends data, changes something, or writes a file")),
  wget: (a) => (readOnlyWget(a) ? SAFE() : MODIFY("Downloads to a file or sends data")),
  for: () => SAFE("Loop header"),
  do: () => SAFE("Loop body follows"),
  done: () => SAFE("End of a loop"),
  then: () => SAFE("Condition body follows"),
  else: () => SAFE("Condition body follows"),
  fi: () => SAFE("End of a condition"),
};
/**
 * `date` prints unless it is given a time to set: -s/--set, or a bare MMDDhhmm. A letter is read
 * for what it is in its group: the `s` of `-Is` belongs to -I (ISO format, to the second), and
 * what follows -d, -f or -r is that option's value, not a time to set.
 */
function date(a: string[]): Judgement {
  const sets = MODIFY("Sets the clock");
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w.startsWith("+")) continue;
    if (w.startsWith("--")) {
      // GNU takes any unambiguous beginning of a long option: --s is --set.
      if (/^--s/.test(w)) return sets;
      if (/^--(da|f|ref)[a-z]*$/.test(w)) i++;
      continue;
    }
    if (!/^-[a-zA-Z]/.test(w)) return sets;
    for (let j = 1; j < w.length; j++) {
      const letter = w[j];
      if (letter === "s") return sets;
      // -I takes its value attached or not at all; -d, -f, -r (and BSD's -v) take the rest of the word or the next one.
      if (letter === "I") break;
      if ("dfrv".includes(letter)) {
        if (j === w.length - 1) i++;
        break;
      }
    }
  }
  return SAFE();
}

/** The first words of NetApp ONTAP's command line. */
const ONTAP_VERBS = new Set(["snapmirror", "volume", "vol", "aggr", "storage", "network", "qos", "lun", "vserver", "cluster", "event", "statistics", "metrocluster", "snapshot", "version", "node", "nfs", "cifs", "iscsi", "igroup", "qtree", "job", "system"]);

/** NetApp ONTAP's command line: `show` reads; `delete` on a volume, aggregate, LUN or SVM loses data. */
function ontap(verb: string, a: string[]): Judgement {
  const words = [verb, ...a.filter((x) => !x.startsWith("-"))];
  if (words.includes("delete") && /^(volume|vol|aggr|aggregate|lun|vserver|svm|snapshot|qtree)$/.test(words[0] === "storage" ? words[1] ?? "" : words[0]))
    return DESTROY("Deletes ONTAP storage (volume, aggregate, LUN, SVM, snapshot)");
  // The command is the words before the first option. A value further on that happens to be "show"
  // (volume modify -volume show …) does not make it a reading one.
  const firstOption = a.findIndex((x) => x.startsWith("-"));
  const command = firstOption < 0 ? a : a.slice(0, firstOption);
  // `node` is also Node.js, where a word after an option is a script: only ONTAP's own "node show" reads.
  if (verb === "node") return a[0] === "show" ? SAFE() : MODIFY("Not on the read-only list (node)");
  if (command.includes("show") || command.includes("show-space") || (verb === "version" && a.length === 0)) return SAFE();
  return MODIFY("NetApp ONTAP storage configuration change");
}
for (const verb of ONTAP_VERBS) RULES[verb] ??= (a) => ontap(verb, a);

/**
 * ONTAP's queries compare with < and >: `event log show -time >2h`, `volume show -size >1TB`.
 * Read as a shell they would be redirections. They are taken as a comparison only where nothing
 * else fits: the command starts with an ONTAP word, the comparison is the value of an option
 * (the word before it is one), and it is a bare number with a unit: never a path, a name or a stream.
 */
function withOntapComparisons(words: Word[]): Word[] {
  if (!ONTAP_VERBS.has(words[0]?.text ?? "") || words[0].quoted) return words;
  return words.map((w, i) =>
    !w.quoted && i > 1 && /^-[a-z]/.test(words[i - 1].text) && /^[<>]=?\d[A-Za-z0-9.:%]*$/.test(w.text) ? { ...w, quoted: true } : w,
  );
}

// mkfs.ext4, mkfs.xfs …
const familyOf = (verb: string): string => (/^mkfs\./.test(verb) ? "mkfs" : verb);

function kubectl(a: string[]): Judgement {
  const words = positional(a.filter((_x, i) => !/^-(n|-namespace|-context|-kubeconfig|l|-selector|o|-output)$/.test(a[i - 1] ?? "")));
  const verb = words[0] ?? "";
  if (verb === "delete") {
    const all = a.includes("--all") || flag(a, "A", "--all-namespaces");
    const kinds = words.slice(1).join(" ").toLowerCase();
    if (all || /\b(namespaces?|ns|nodes?|no|pv|pvc|persistentvolumes?|persistentvolumeclaims?|crds?|customresourcedefinitions?|all|statefulsets?|sts|deployments?|deploy|daemonsets?|ds)\b/.test(kinds))
      return DESTROY("Deletes Kubernetes resources that are hard to get back");
    return MODIFY("Deletes Kubernetes resources");
  }
  if (["drain"].includes(verb)) return MODIFY("Moves every pod off a node");
  if (["get", "describe", "top", "events", "explain", "version", "cluster-info", "api-resources", "api-versions"].includes(verb) || (verb === "auth" && words[1] === "can-i") || (verb === "config" && /^(view|get-contexts|current-context)$/.test(words[1] ?? "")))
    return flag(a, "w", "--watch") || has(a, /^--watch-only/) ? MODIFY(NEVER_ENDS) : SAFE();
  if (verb === "logs") return flag(a, "f", "--follow") ? MODIFY(NEVER_ENDS) : SAFE();
  if (verb === "exec") return MODIFY("Runs a command in a container");
  return MODIFY("Kubernetes workload/cluster state change");
}

function systemctl(a: string[]): Judgement {
  const verb = positional(a)[0] ?? "";
  if (/^(reboot|poweroff|halt|kexec|emergency|rescue|isolate|soft-reboot)$/.test(verb)) return DESTROY("Reboots, halts or isolates the system");
  if (!verb || /^(status|is-active|is-enabled|is-failed|is-system-running|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|list-jobs|show|cat|get-default)$/.test(verb) || a.includes("--failed"))
    return SAFE();
  return MODIFY("Systemd service state modification");
}

function iptables(a: string[]): Judgement {
  if (flag(a, "F", "--flush") || flag(a, "X", "--delete-chain") || (has(a, /^-P$/, /^--policy$/) && a.includes("DROP"))) return DESTROY("Flushes the firewall or drops all traffic");
  if (a.every((x) => /^(-[LSnvx]+|--list|--list-rules|--line-numbers|-t|nat|filter|mangle|raw|security|-w|\d+|[A-Z][A-Z_-]*)$/.test(x)) && (flag(a, "L", "--list") || flag(a, "S", "--list-rules")))
    return SAFE();
  return MODIFY("Changes the firewall");
}

function containers(a: string[]): Judgement {
  const verb = positional(a)[0] ?? "";
  const sub = positional(a)[1] ?? "";
  if ((verb === "system" && sub === "prune") || (verb === "volume" && (sub === "rm" || sub === "prune")) || (verb === "compose" && sub === "down" && flag(a, "v", "--volumes")))
    return DESTROY("Removes containers' data");
  if (/^(ps|images|inspect|version|info|top|port|diff|history)$/.test(verb)) return SAFE();
  if (verb === "logs") return flag(a, "f", "--follow") ? MODIFY(NEVER_ENDS) : SAFE();
  if (verb === "stats") return a.includes("--no-stream") ? SAFE() : MODIFY(NEVER_ENDS);
  if (/^(network|volume)$/.test(verb) && /^(ls|inspect)$/.test(sub)) return SAFE();
  if (verb === "compose" && /^(ps|config|images|top|ls|version)$/.test(sub)) return SAFE();
  if (verb === "compose" && sub === "logs") return flag(a, "f", "--follow") ? MODIFY(NEVER_ENDS) : SAFE();
  return MODIFY("Container lifecycle mutation");
}

function redis(a: string[]): Judgement {
  let i = 0;
  while (i < a.length && /^-[hpnau]$|^--(user|pass|tls)/.test(a[i])) i += a[i].startsWith("--tls") ? 1 : 2;
  const rest = a.slice(i).map((x) => x.toLowerCase());
  if (rest[0] === "flushall" || rest[0] === "flushdb") return DESTROY("Deletes every key");
  if ((rest.length === 1 && ["ping", "dbsize", "info", "time", "lastsave", "role"].includes(rest[0])) || (rest.length === 2 && rest[0] === "info")) return SAFE();
  return MODIFY("Runs a Redis command");
}

function sql(all: string): Judgement {
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded by the text of one command, and each group is anchored on a keyword
  if (/\b(drop\s+(database|table|schema|user|role)|truncate(\s+table)?\s+\w|delete\s+from\s+\w+\s*(;|$|")(?![\s\S]*\bwhere\b))/i.test(all)) return DESTROY("Drops or empties a database, table or schema");
  return MODIFY("Runs database commands");
}

function sed(a: string[]): Judgement {
  if (flag(a, "i", "--in-place") || a.some((x) => x.startsWith("--in-place") || /^-[a-zA-Z]*i/.test(x))) return MODIFY("Edits a file in place");
  // The script: what follows -e, or the first word that is not an option. A `w` or `e` command writes or runs.
  const scripts = a.flatMap((x, i) => (a[i - 1] === "-e" || a[i - 1] === "--expression" ? [x] : []));
  const script = scripts.length ? scripts.join("\n") : positional(a)[0] ?? "";
  if (/(^|[;}\s/0-9$])[wWe](\s|$)|\/[a-zA-Z]*[we]\b/.test(script)) return MODIFY("The sed script writes a file or runs a command");
  return SAFE();
}

function awk(a: string[]): Judgement {
  if (flag(a, "i") || a.includes("--include") || a.some((x) => x === "inplace")) return MODIFY("Edits a file in place");
  const program = a.filter((x, i) => !x.startsWith("-") && !/^-(F|v|f)$/.test(a[i - 1] ?? "")).at(0) ?? "";
  if (a.some((_x, i) => a[i - 1] === "-f")) return MODIFY("Runs an awk program from a file");
  if (/\bsystem\s*\(|\|\s*["\w$]|["\w$)]\s*\|\s*getline|\bprintf?\b[^;}]*>|\bfflush\b|\bclose\s*\(/.test(program)) return MODIFY("The awk program runs a command or writes a file");
  return SAFE();
}

function find(a: string[]): Judgement {
  if (a.includes("-delete")) return DESTROY("Bulk file deletion via find -delete");
  if (a.some((x) => /^-(fprint0?|fprintf|fls)$/.test(x))) return MODIFY("find writes its list to a file");
  return SAFE();
}

/** The commands `find -exec …` runs, each as a command of its own. */
function findExecs(a: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < a.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(a[i])) continue;
    const cmd: string[] = [];
    for (i++; i < a.length && a[i] !== ";" && a[i] !== "+"; i++) cmd.push(a[i]);
    out.push(cmd);
  }
  return out;
}

function ip(a: string[]): Judgement {
  const words = a.filter((x) => !/^-/.test(x));
  const object = words[0] ?? "";
  const verb = words[1] ?? "";
  if (!object || !verb || /^(show|list|ls|lst|get|sh|s|l)$/.test(verb) || (object === "monitor" ? false : /^(dev|to|from|table|vrf)$/.test(verb)))
    return object === "monitor" ? MODIFY(NEVER_ENDS) : SAFE();
  return MODIFY("Changes network interfaces, addresses or routes");
}

/** Flags of curl that take a value as the next word (or the rest of a short-flag group). */
const CURL_VALUE = "XoDKdFTHAeEuUxbcCrmwyYzQ";
const CURL_WRITES = /^--(data.*|json|form.*|upload-file|config|remote-name.*|cookie-jar|create-dirs|remote-header-name|dump-header|trace.*|stderr|libcurl|quote|etag-save|hsts|alt-svc|output-dir|output)$/;

/** A curl that only asks: GET or HEAD, nothing sent, nothing written (output to the terminal or /dev/null). */
function readOnlyCurl(a: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w.startsWith("--")) {
      const [name, inline] = w.split(/=(.*)/s);
      if (name === "--request") {
        const m = inline ?? a[++i];
        if (!/^(GET|HEAD)$/i.test(m ?? "")) return false;
        continue;
      }
      if (name === "--output") {
        const o = inline ?? a[++i];
        if (!HARMLESS_TARGET.test(o ?? "")) return false;
        continue;
      }
      if (CURL_WRITES.test(name)) return false;
      continue;
    }
    if (!/^-[a-zA-Z0-9#]+/.test(w)) continue;
    // A short-flag group, read a letter at a time: a letter that takes a value takes the rest, or the next word.
    for (let j = 1; j < w.length; j++) {
      const letter = w[j];
      if (/[dFTKOJcDQ]/.test(letter)) return false;
      if (CURL_VALUE.includes(letter)) {
        const value = w.slice(j + 1) || a[++i] || "";
        if (letter === "X" && !/^(GET|HEAD)$/i.test(value)) return false;
        if (letter === "o" && !HARMLESS_TARGET.test(value)) return false;
        break;
      }
    }
  }
  return true;
}

/** A wget that fetches to the terminal or to nowhere, and writes no log, cookie or file. */
function readOnlyWget(a: string[]): boolean {
  let toTerminal = false;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (/^--(post-|method=(?!GET$|HEAD$)|body-|input-file|mirror|recursive|save-cookies|output-file|append-output|execute|directory-prefix|warc)/i.test(w)) return false;
    if (w === "--spider") toTerminal = true;
    if (/^--output-document=/.test(w)) {
      if (!HARMLESS_TARGET.test(w.split("=")[1] ?? "")) return false;
      toTerminal = true;
    }
    if (/^-[a-zA-Z]/.test(w) && !w.startsWith("--")) {
      for (let j = 1; j < w.length; j++) {
        const letter = w[j];
        if (/[oaeiPrmx]/.test(letter)) return false;
        if (letter === "O") {
          const value = w.slice(j + 1) || a[++i] || "";
          if (!HARMLESS_TARGET.test(value)) return false;
          toTerminal = true;
          break;
        }
      }
    }
  }
  return toTerminal;
}

/**
 * `bash -n script`, `cat script | sh -n`: the shell reads the script, reports syntax errors and runs none of it.
 * Only the shell's own options count, the ones before the script's name: `bash x.sh -n` hands -n to the script.
 * A shell with nothing to read but the terminal is interactive, and an interactive shell ignores -n:
 * so the script has to be named, or come in through a pipe.
 */
function onlyParses(args: string[], fedByPipe: boolean): boolean {
  let noexec = false;
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") {
      script = i + 1 < args.length;
      break;
    }
    if (!/^[-+]/.test(w)) {
      script = true;
      break;
    }
    if (w === "--no-execute") noexec = true; // fish
    if (w === "--interactive") return false;
    if (w.startsWith("--")) {
      if (w === "--rcfile" || w === "--init-file") i++;
      continue;
    }
    if (w.startsWith("-") && w.includes("i")) return false;
    // +n and +o noexec switch it back on: whatever came before, the script would run.
    if (w.startsWith("+") && (w.includes("n") || args[i + 1] === "noexec")) return false;
    if (w.startsWith("-") && w.includes("n")) noexec = true;
    if (/^[-+][a-zA-Z]*[oO]$/.test(w)) {
      if (w.startsWith("-") && args[i + 1] === "noexec") noexec = true;
      i++;
    }
  }
  return noexec && (script || fedByPipe);
}

/** One simple command, judged: what runs, after its wrappers, with its own arguments. */
function judge(segment: string, depth: number, found: string[], fedByPipe = false): Judgement {
  if (segment === TOO_DEEP) return MODIFY("Nested too deep to read");
  // Grouping brackets and the words that only shape a script.
  const cleaned = segment.replace(/^[({\s]+/, "").replace(/[)}\s]+$/, "").replace(/^(!|if|while|until|elif|then|do|else)\s+/, "");
  if (!cleaned) return SAFE();
  const { words, writes } = withoutRedirections(withOntapComparisons(shellWords(cleaned)));
  let verdict: Judgement = writes ? MODIFY(`Writes to a file (> ${writes})`) : SAFE();
  const wrappers: string[] = [];
  const assigned: string[] = [];
  const run = unwrap(
    words.map((w) => w.text),
    wrappers,
    assigned,
  );
  if (wrappers.includes("watch")) verdict = worse(verdict, MODIFY(NEVER_ENDS));
  const risky = assigned.map(riskyAssignment).find(Boolean);
  if (risky) verdict = worse(verdict, MODIFY(`Sets ${risky}, which changes what the command loads or runs`));
  if (run.length === 0) {
    // sudo -i, sudo -s: nothing is run, a shell as root is what is left. Every later line would then run as root.
    const shell = wrappers.find((x) => x.startsWith(SHELL_AS));
    if (shell) return worse(verdict, MODIFY(`Starts a shell as another user (${shell.slice(SHELL_AS.length)})`));
    return wrappers.includes("xargs") ? verdict : worse(verdict, wrappers.length ? SAFE() : verdict);
  }
  const verb = familyOf((run[0] ?? "").replace(/^.*\//, ""));
  const args = run.slice(1);

  // Something that runs a script: judge the script.
  if (SHELLS.has(verb) || verb === "su" || verb === "runuser") {
    const at = args.findIndex((x) => /^-[a-zA-Z]*c$/.test(x) || x === "--command");
    if (at >= 0 && args[at + 1] !== undefined) return worse(verdict, analyze(args[at + 1], depth + 1, found).judgement);
    if (verb === "su" || verb === "runuser") return worse(verdict, MODIFY("Runs as another user"));
    if (onlyParses(args, fedByPipe)) return worse(verdict, SAFE());
    if (positional(args).length === 0) return worse(verdict, DESTROY("Runs whatever it is fed as a script (… | sh)"));
    return worse(verdict, MODIFY("Runs a script"));
  }
  if (verb === "eval") return worse(verdict, analyze(args.join(" "), depth + 1, found).judgement);
  if (verb === "find") for (const exec of findExecs(args)) verdict = worse(verdict, judgeWords(exec, depth, found));

  const rule = RULES[verb];
  const own = rule?.(args, args.join(" "));
  return worse(verdict, own ?? MODIFY(`Not on the read-only list (${verb})`));
}

/** A command given as words (from find -exec): judged as if written out. */
function judgeWords(words: string[], depth: number, found: string[]): Judgement {
  const text = words.map((w) => (/[\s'"$`;&|<>()]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w)).join(" ");
  return analyze(text, depth + 1, found).judgement;
}

/** `found` collects every command read, including those inside scripts and -exec, for the approval card. */
function analyze(command: string, depth: number, found: string[] = []): { judgement: Judgement; segments: string[]; reasons: string[] } {
  const pipes: PipeUse = { fed: new Set(), bare: new Set() };
  const segments = splitShellAstSegments(command, depth, pipes);
  for (const s of segments) if (!found.includes(s)) found.push(s);
  let judgement: Judgement = SAFE("Empty command");
  const reasons: string[] = [];
  for (const segment of segments) {
    // The same words written once after a pipe and once without one are judged as the one without.
    const j = judge(segment, depth, found, pipes.fed.has(segment) && !pipes.bare.has(segment));
    if (j.level !== "safe" && !reasons.includes(j.reason)) reasons.push(j.reason);
    judgement = worse(judgement, j);
  }
  if (segments.length && judgement.level === "safe") judgement = SAFE();
  return { judgement: { level: judgement.level, reason: reasons.join(" · ") || judgement.reason }, segments, reasons };
}

export function analyzeCommandSafety(command: string): CommandRiskAnalysis {
  const found: string[] = [];
  const { judgement } = analyze(command, 0, found);
  return {
    riskLevel: judgement.level,
    riskReason: judgement.reason,
    parsedSubcommands: found.filter((s) => s !== TOO_DEEP),
  };
}

/** The tags that mark a server as one where a change waits for a person (see `requireApprovalOnProdTags`). */
export function isProdTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return t === "prod" || t === "production" || t === "critical";
}

export function shouldRequireCommandApproval(opts: {
  analysis: CommandRiskAnalysis;
  mode: AgentMode;
  targetTags?: string[];
  policy?: SafetyPolicyConfig;
}): boolean {
  const policy = opts.policy ?? DEFAULT_SAFETY_POLICY;
  const isProdTarget = (opts.targetTags ?? []).some(isProdTag);

  if (opts.mode === "advice") {
    return true;
  }

  if (
    opts.analysis.riskLevel === "destructive" &&
    policy.blockDestructiveWithoutConfirm
  ) {
    return true;
  }

  if (opts.mode === "autonomous") {
    if (
      opts.analysis.riskLevel !== "safe" &&
      policy.requireApprovalOnProdTags &&
      isProdTarget
    ) {
      return true;
    }
    return false;
  }

  // Assisted mode: auto-approve verified read-only commands when autoApproveSafeReadOnly is enabled
  if (
    opts.analysis.riskLevel === "safe" &&
    policy.autoApproveSafeReadOnly
  ) {
    return false;
  }

  return true;
}
