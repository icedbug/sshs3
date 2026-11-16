import { normalizePath, type SimCert, type SimDisk, type SimHost, type SimLogLine, type SimService } from "../SimHost";
import { fail, globToRegExp, lines, NotSimulated, ok, parseArgs, type SimCommand, type SimContext, type SimResult } from "../SimShell";

/**
 * The system and service commands of a simulated Ubuntu/Debian server with
 * systemd: what somebody types at a prompt to see how a machine is, and to
 * start and stop what runs on it.
 *
 * Every answer is read from the host's state, in the layout the real tool
 * prints. The host's clock is taken as UTC, as a server's usually is.
 */

// ---- small tools -------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const p2 = (n: number): string => String(n).padStart(2, "0");
const sp2 = (n: number): string => String(n).padStart(2, " ");

/** A number that is always the same for the same text: what stands in for chance. */
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Stirred once more, so that texts that differ by a letter give numbers that have nothing in common.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const hex = (seed: string, length: number): string => {
  let out = "";
  for (let i = 0; out.length < length; i++) out += hash(`${seed}#${i}`).toString(16).padStart(8, "0");
  return out.slice(0, length);
};

const hms = (ms: number): string => {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};
const ymd = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
};
/** `Nov 13 18:27:03`, the way syslog and the journal write a time. */
const syslogTime = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${hms(ms)}`;
};
/** `Fri 2026-11-13 18:27:03 UTC`, the way systemd writes one. */
const systemdTime = (ms: number): string => `${DAYS[new Date(ms).getUTCDay()]} ${ymd(ms)} ${hms(ms)} UTC`;
/** `Nov 21 12:00:00 2026 GMT`, the way openssl writes one. */
const opensslTime = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${sp2(d.getUTCDate())} ${hms(ms)} ${d.getUTCFullYear()} GMT`;
};
/** `Mon Nov 16 11:42`, the way `last` writes one. */
const lastTime = (ms: number): string => {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${sp2(d.getUTCDate())} ${hms(ms).slice(0, 5)}`;
};
const startOfDay = (ms: number): number => ms - (ms % 86_400_000);

function strftime(ms: number, format: string): string {
  const d = new Date(ms);
  const dayOfYear = Math.floor((startOfDay(ms) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const one = (c: string): string => {
    switch (c) {
      case "Y": return String(d.getUTCFullYear());
      case "y": return p2(d.getUTCFullYear() % 100);
      case "m": return p2(d.getUTCMonth() + 1);
      case "d": return p2(d.getUTCDate());
      case "e": return sp2(d.getUTCDate());
      case "H": return p2(d.getUTCHours());
      case "I": return p2(d.getUTCHours() % 12 || 12);
      case "M": return p2(d.getUTCMinutes());
      case "S": return p2(d.getUTCSeconds());
      case "N": return String(d.getUTCMilliseconds()).padStart(3, "0").padEnd(9, "0");
      case "s": return String(Math.floor(ms / 1000));
      case "F": return ymd(ms);
      case "T": return hms(ms);
      case "R": return hms(ms).slice(0, 5);
      case "D": return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCFullYear() % 100)}`;
      case "a": return DAYS[d.getUTCDay()];
      case "A": return DAY_NAMES[d.getUTCDay()];
      case "b": case "h": return MONTHS[d.getUTCMonth()];
      case "B": return MONTH_NAMES[d.getUTCMonth()];
      case "j": return String(dayOfYear).padStart(3, "0");
      case "u": return String(d.getUTCDay() || 7);
      case "w": return String(d.getUTCDay());
      case "p": return d.getUTCHours() < 12 ? "AM" : "PM";
      case "Z": return "UTC";
      case "z": return "+0000";
      case "c": return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${sp2(d.getUTCDate())} ${hms(ms)} ${d.getUTCFullYear()}`;
      case "n": return "\n";
      case "t": return "\t";
      case "%": return "%";
      default: return `%${c}`;
    }
  };
  let out = "";
  for (let i = 0; i < format.length; i++) {
    if (format[i] === "%" && i + 1 < format.length) out += one(format[++i]);
    else out += format[i];
  }
  return out;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How long ago, in systemd's words: `3 days ago`, `1h 12min ago`. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const H = 3600;
  const D = 86_400;
  const MONTH = 2_629_800;
  const YEAR = 31_557_600;
  if (s >= YEAR) return `${plural(Math.floor(s / YEAR), "year")} ${plural(Math.floor((s % YEAR) / MONTH), "month")} ago`;
  if (s >= MONTH) return `${plural(Math.floor(s / MONTH), "month")} ${plural(Math.floor((s % MONTH) / D), "day")} ago`;
  if (s >= 7 * D) return `${plural(Math.floor(s / (7 * D)), "week")} ${plural(Math.floor((s % (7 * D)) / D), "day")} ago`;
  if (s >= 2 * D) return `${Math.floor(s / D)} days ago`;
  if (s >= 25 * H) return `1 day ${Math.floor((s - D) / H)}h ago`;
  if (s >= H) return `${Math.floor(s / H)}h ${Math.floor((s % H) / 60)}min ago`;
  if (s >= 60) return `${Math.floor(s / 60)}min ${s % 60}s ago`;
  return `${s}s ago`;
}

/** A span of processor time in systemd's words: `1.204s`, `3min 12.500s`, `1d 4h 32min 7.910s`. */
function systemdSpan(seconds: number): string {
  const whole = Math.floor(seconds);
  const parts = [
    ...(whole >= 86_400 ? [`${Math.floor(whole / 86_400)}d`] : []),
    ...(whole >= 3600 && Math.floor((whole % 86_400) / 3600) ? [`${Math.floor((whole % 86_400) / 3600)}h`] : []),
    ...(whole >= 60 && Math.floor((whole % 3600) / 60) ? [`${Math.floor((whole % 3600) / 60)}min`] : []),
    `${(seconds - whole + (whole % 60)).toFixed(3)}s`,
  ];
  return parts.join(" ");
}

/** A size the way GNU `df -h` and `lsblk` round it: up, one decimal below ten. */
function humanCeil(bytes: number): string {
  const units = ["", "K", "M", "G", "T", "P"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return String(Math.ceil(value));
  let shown = value < 10 ? Math.ceil(value * 10 - 1e-9) / 10 : Math.ceil(value - 1e-9);
  if (shown >= 1024 && unit < units.length - 1) {
    shown = 1;
    unit++;
  }
  return `${value < 10 && shown < 10 ? shown.toFixed(1) : String(shown)}${units[unit]}`;
}

/** A size the way `free -h` writes it: `15Gi`, `2.3Gi`, `512Mi`. */
function humanIec(kb: number): string {
  if (kb === 0) return "0B";
  const units = ["Ki", "Mi", "Gi", "Ti"];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))}${units[unit]}`;
}

/** Rows as columns: each as wide as its widest cell, the last one left as it is. */
function table(rows: string[][], right: number[] = [], gap = " "): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) =>
    row
      .map((cell, i) => (right.includes(i) ? cell.padStart(widths[i]) : i === row.length - 1 ? cell : cell.padEnd(widths[i])))
      .join(gap)
      .trimEnd(),
  );
}

/** Every value given to an option that may be given more than once: `-p A -p B`, `--property=A,B`. */
function optionValues(args: string[], short: string, long: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === `--${long}` || a === `-${short}`) {
      if (i + 1 < args.length) out.push(args[++i]);
    } else if (a.startsWith(`--${long}=`)) out.push(a.slice(long.length + 3));
    else if (a.startsWith(`-${short}`) && !a.startsWith("--") && a.length > 2) out.push(a.slice(2));
  }
  return out;
}

const CODENAMES: Record<string, string> = { "24.04": "noble", "22.04": "jammy", "20.04": "focal", "12": "bookworm", "11": "bullseye", "13": "trixie" };
const codename = (host: SimHost): string => CODENAMES[host.os.version] ?? CODENAMES[host.os.version.split(".").slice(0, 2).join(".")] ?? "stable";
const distributor = (host: SimHost): string => host.os.id.charAt(0).toUpperCase() + host.os.id.slice(1);

/** Where the person at the prompt came from: a neighbour on the same network. */
const clientAddress = (host: SimHost): string => {
  const given = host.facts.get("client");
  if (typeof given === "string") return given;
  const parts = host.address.split(".");
  return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.${parts[3] === "10" ? "11" : "10"}` : "10.0.0.10";
};
const loginAt = (host: SimHost): number => {
  const at = host.now() - 18 * 60_000;
  return at - (at % 60_000);
};

// ---- processes, memory, load -------------------------------------------------

interface Proc {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
  comm: string;
  since: number;
  tty: string;
  stat: string;
  service?: SimService;
  /** One of `host.processes`: it goes when it is killed. */
  extra?: boolean;
}

/** The name of the program a command line runs, as `ps -o comm` and `pgrep` know it. */
const commOf = (command: string): string => {
  const first = command.trim().split(/\s+/)[0].replace(/:$/, "");
  if (first.startsWith("[")) return first.replace(/[[\]]/g, "").split("/")[0];
  return first.slice(first.lastIndexOf("/") + 1).replace(/^-/, "").slice(0, 15);
};

const serviceCommand = (service: SimService): string => service.command ?? `/usr/sbin/${service.name}`;

function processes(host: SimHost): Proc[] {
  const fixed = (pid: number, ppid: number, user: string, command: string, mem = 0.1, tty = "?", stat = "Ss", since = host.bootAt): Proc => ({
    pid, ppid, user, cpu: 0, mem, command, comm: commOf(command), since, tty, stat,
  });
  const login = loginAt(host);
  const out: Proc[] = [
    { ...fixed(1, 0, "root", "/sbin/init", 0.1), comm: "systemd" },
    fixed(2, 0, "root", "[kthreadd]", 0, "?", "S"),
    fixed(14, 2, "root", "[ksoftirqd/0]", 0, "?", "S"),
    fixed(412, 1, "root", "/usr/lib/systemd/systemd-journald", 0.3),
    fixed(455, 1, "root", "/usr/lib/systemd/systemd-udevd", 0.1),
  ];
  if (!host.service("cron")) out.push(fixed(812, 1, "root", "/usr/sbin/cron -f -P", 0));
  if (!host.service("ssh") && !host.service("sshd")) out.push(fixed(901, 1, "root", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", 0.1));
  const sshd = host.service("ssh")?.pid ?? host.service("sshd")?.pid ?? 901;
  out.push(
    fixed(1480, sshd, "root", `sshd: ${host.user} [priv]`, 0.1, "?", "Ss", login),
    fixed(1499, 1480, host.user, `sshd: ${host.user}@pts/0`, 0.1, "?", "S", login),
    fixed(1500, 1499, host.user, "-bash", 0.1, "pts/0", "Ss", login),
  );
  for (const service of host.services.values()) {
    if (service.state !== "active" || service.pid === undefined) continue;
    const command = serviceCommand(service);
    const h = hash(service.name);
    out.push({
      pid: service.pid, ppid: 1, user: service.user ?? "root", cpu: (h % 30) / 10, mem: 0.3 + ((h >>> 8) % 40) / 10,
      command, comm: commOf(command), since: service.since, tty: "?", stat: "Ssl", service,
    });
  }
  for (const p of host.processes) {
    out.push({ pid: p.pid, ppid: 1, user: p.user, cpu: p.cpu, mem: p.mem, command: p.command, comm: commOf(p.command), since: host.bootAt, tty: "?", stat: p.cpu >= 50 ? "R" : "S", extra: true });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

const totalKb = (host: SimHost): number => host.memoryMb * 1024;
const rssKb = (host: SimHost, p: Proc): number => Math.round((p.mem / 100) * totalKb(host));
const vszKb = (host: SimHost, p: Proc): number => (p.command.startsWith("[") ? 0 : rssKb(host, p) * 3 + 8192 + (hash(p.command) % 4096));

/** Memory in kB: what the processes take, a share for the kernel, and a cache as a busy machine keeps one. */
function memory(host: SimHost): { total: number; used: number; free: number; shared: number; cache: number; available: number; swap: number } {
  const total = totalKb(host);
  const taken = processes(host).reduce((sum, p) => sum + rssKb(host, p), 0);
  const used = Math.min(Math.round(total * 0.95), Math.round(total * 0.04) + taken);
  const cache = Math.round((total - used) * 0.55);
  const free = total - used - cache;
  return { total, used, free, shared: Math.round(total * 0.004), cache, available: free + Math.round(cache * 0.92), swap: 2_097_148 };
}

/** The load average: what a scenario put under "load", or what the processes add up to. */
function load(host: SimHost): [number, number, number] {
  const given = host.facts.get("load");
  if (typeof given === "number") return [given, given * 0.92, given * 0.85];
  if (Array.isArray(given) && given.length === 3 && given.every((n) => typeof n === "number")) return given as [number, number, number];
  const base = processes(host).reduce((sum, p) => sum + p.cpu, 0) / 100 + 0.03;
  return [base, base * 0.8, base * 0.6];
}

function uptimeLine(host: SimHost): string {
  const up = Math.max(0, Math.floor((host.now() - host.bootAt) / 1000));
  const days = Math.floor(up / 86_400);
  const hours = Math.floor((up % 86_400) / 3600);
  const minutes = Math.floor((up % 3600) / 60);
  const parts = [days ? `${days} day${days === 1 ? "" : "s"}, ` : "", hours ? `${sp2(hours)}:${p2(minutes)}` : `${minutes} min`].join("");
  return ` ${hms(host.now())} up ${parts},  1 user,  load average: ${load(host).map((n) => n.toFixed(2)).join(", ")}`;
}

/** When a process started, as `ps` shows it: the time today, the day before that. */
const startColumn = (host: SimHost, since: number): string => {
  if (startOfDay(since) === startOfDay(host.now())) return hms(since).slice(0, 5);
  const d = new Date(since);
  return `${MONTHS[d.getUTCMonth()]}${p2(d.getUTCDate())}`;
};
const cpuSeconds = (host: SimHost, p: Proc): number => Math.floor(((host.now() - p.since) / 1000) * (p.cpu / 100)) + (p.pid === 1 ? 12 : 0);
const shortCpuTime = (s: number): string => `${Math.floor(s / 60)}:${p2(s % 60)}`;
const longCpuTime = (s: number): string => `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;

// ---- systemctl, service ------------------------------------------------------

const UNIT_SUFFIX = /\.(service|socket|timer|target|mount|automount|path|slice|scope|swap|device)$/;
const unitName = (raw: string): string => (UNIT_SUFFIX.test(raw) ? raw : `${raw}.service`);
const findService = (host: SimHost, raw: string): SimService | undefined => (unitName(raw).endsWith(".service") ? host.service(raw) : undefined);
const subState = (service: SimService): string => (service.state === "active" ? "running" : service.state === "failed" ? "failed" : "dead");
const unitPath = (host: SimHost, service: SimService): string =>
  [`/etc/systemd/system/${service.name}.service`, `/lib/systemd/system/${service.name}.service`, `/usr/lib/systemd/system/${service.name}.service`].find((p) => host.read(p)) ??
  `/lib/systemd/system/${service.name}.service`;

/** The journal of a unit: what it wrote, and what systemd wrote about it. */
const ofUnit = (line: SimLogLine, raw: string): boolean => {
  const name = raw.replace(/\.service$/, "");
  return line.unit === name || line.unit === unitName(raw) || (line.unit === "systemd" && line.text.includes(`${name}.service`));
};
const journalIdent = (host: SimHost, unit: string): string => {
  if (unit === "kernel") return "kernel";
  if (unit === "systemd") return "systemd[1]";
  const name = unit.replace(/\.service$/, "");
  return `${name}[${host.service(name)?.pid ?? 500 + (hash(name) % 1400)}]`;
};
const journalShort = (host: SimHost, line: SimLogLine): string[] =>
  line.text.split("\n").map((text) => `${syslogTime(line.at)} ${host.name} ${journalIdent(host, line.unit)}: ${text}`);
const sortedJournal = (host: SimHost): SimLogLine[] =>
  host.journal.map((line, index) => ({ line, index })).sort((a, b) => a.line.at - b.line.at || a.index - b.index).map((x) => x.line);

function unitFile(host: SimHost, service: SimService): string {
  const path = unitPath(host, service);
  const real = host.read(path);
  if (real) return `# ${path}\n${real.content.endsWith("\n") ? real.content : `${real.content}\n`}`;
  return lines([
    `# ${path}`,
    "[Unit]",
    `Description=${service.description}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    ...(service.user && service.user !== "root" ? [`User=${service.user}`, `Group=${service.user}`] : []),
    `ExecStart=${serviceCommand(service)}`,
    "ExecReload=/bin/kill -HUP $MAINPID",
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ]);
}

function statusOf(host: SimHost, service: SimService, journalLines: number): string[] {
  const now = host.now();
  const unit = `${service.name}.service`;
  const enabled = service.enabled ? "enabled" : "disabled";
  const since = `since ${systemdTime(service.since)}; ${ago(now - service.since)}`;
  const command = serviceCommand(service);
  const out: string[] = [];
  const mark = service.state === "active" ? "●" : service.state === "failed" ? "×" : "○";
  out.push(`${mark} ${unit} - ${service.description}`);
  out.push(`     Loaded: loaded (${unitPath(host, service)}; ${enabled}; preset: enabled)`);
  if (service.state === "active") {
    const h = hash(service.name);
    out.push(`     Active: active (running) ${since}`);
    out.push(`   Main PID: ${service.pid} (${commOf(command)})`);
    out.push(`      Tasks: ${1 + (h % 8)} (limit: ${Math.floor(host.memoryMb * 1.16)})`);
    out.push(`     Memory: ${(((0.3 + ((h >>> 8) % 40) / 10) / 100) * host.memoryMb).toFixed(1)}M`);
    out.push(`        CPU: ${systemdSpan(((now - service.since) / 1000) * ((h % 30) / 1000) + 0.05)}`);
    out.push(`     CGroup: /system.slice/${unit}`);
    out.push(`             └─${service.pid} ${command}`);
  } else if (service.state === "failed") {
    const pid = 1000 + (hash(`${service.name}${service.since}`) % 30_000);
    out.push(`     Active: failed (Result: exit-code) ${since}`);
    out.push(`    Process: ${pid} ExecStart=${command} (code=exited, status=1/FAILURE)`);
    out.push(`   Main PID: ${pid} (code=exited, status=1/FAILURE)`);
    out.push("        CPU: 21ms");
  } else {
    // A unit that never ran since boot has no time to show; one that was stopped says when.
    out.push(service.since > host.bootAt + 60_000 ? `     Active: inactive (dead) ${since}` : "     Active: inactive (dead)");
  }
  const tail = journalLines > 0 ? sortedJournal(host).filter((l) => ofUnit(l, service.name)).slice(-journalLines) : [];
  if (tail.length) out.push("", ...tail.flatMap((l) => journalShort(host, l)));
  return out;
}

/** The services a list of names and patterns means, and the names that mean none. */
function resolveUnits(host: SimHost, names: string[]): { raw: string; service?: SimService }[] {
  const out: { raw: string; service?: SimService }[] = [];
  for (const raw of names) {
    if (/[*?[]/.test(raw)) {
      const test = globToRegExp(unitName(raw));
      for (const service of host.services.values()) if (test.test(`${service.name}.service`)) out.push({ raw: service.name, service });
    } else out.push({ raw, service: findService(host, raw) });
  }
  return out;
}

const SYSTEMCTL_VALUES = ["type", "t", "state", "p", "property", "n", "lines", "o", "output", "s", "signal", "kill-whom", "H", "host", "job-mode"];
const JOB_VERBS = ["start", "stop", "restart", "reload", "try-restart", "condrestart", "reload-or-restart", "try-reload-or-restart", "force-reload", "kill"];

function systemctl(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { flags, values, rest } = parseArgs(args, SYSTEMCTL_VALUES);
  if (flags.has("user")) throw new NotSimulated("systemctl --user");
  if (flags.has("version")) return ok(lines(["systemd 255 (255.4-1ubuntu8)", "+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -BPF_FRAMEWORK -XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified"]));
  const verb = rest[0] ?? "list-units";
  const names = rest.slice(1);
  const quiet = flags.has("q") || flags.has("quiet");
  const all = [...host.services.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (verb === "list-units") {
    const types = (values.get("type") ?? values.get("t"))?.split(",");
    const states = [...(values.get("state")?.split(",") ?? []), ...(flags.has("failed") ? ["failed"] : [])];
    const everything = flags.has("all") || flags.has("a");
    const patterns = names.map((n) => globToRegExp(unitName(n)));
    const shown = all.filter((s) => {
      if (types && !types.includes("service")) return false;
      if (patterns.length && !patterns.some((p) => p.test(`${s.name}.service`))) return false;
      if (states.length) return states.includes(s.state) || states.includes(subState(s)) || states.includes("loaded");
      return everything || s.state !== "inactive";
    });
    const plain = flags.has("plain");
    const rows = shown.map((s) => [`${s.name}.service`, "loaded", s.state, subState(s), s.description]);
    const laid = table(flags.has("no-legend") ? rows : [["UNIT", "LOAD", "ACTIVE", "SUB", "DESCRIPTION"], ...rows]);
    const marked = laid.map((row, i) => {
      if (plain) return row;
      const service = flags.has("no-legend") ? shown[i] : shown[i - 1];
      return `${service?.state === "failed" ? "●" : " "} ${row}`;
    });
    if (flags.has("no-legend")) return ok(lines(marked));
    const hint = everything || states.length ? "" : " Pass --all to see loaded but inactive units, too.";
    return ok(
      lines([
        ...marked,
        "",
        ...(shown.length
          ? [
              "Legend: LOAD   → Reflects whether the unit definition was properly loaded.",
              "        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.",
              "        SUB    → The low-level unit activation state, values depend on unit type.",
              "",
            ]
          : []),
        `${shown.length} loaded units listed.${hint}`,
        ...(states.length ? [] : ["To show all installed unit files use 'systemctl list-unit-files'."]),
      ]),
    );
  }

  if (verb === "list-timers") {
    const at = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const now = host.now();
    const timers: [string, number, number][] = [
      ["apt-daily.timer", now + 5 * 3_600_000, now - 19 * 3_600_000],
      ["logrotate.timer", now + 14 * 3_600_000, now - 10 * 3_600_000],
      ...(host.packages.certbot && !host.read("/etc/cron.d/certbot") ? ([["certbot.timer", now + 7 * 3_600_000, now - 5 * 3_600_000]] as [string, number, number][]) : []),
    ];
    return ok(lines(["NEXT                        LAST                        UNIT              ACTIVATES", ...timers.map(([unit, next, last]) => `${at(next)} UTC     ${at(last)} UTC     ${unit.padEnd(17)} ${unit.replace(".timer", ".service")}`), "", `${timers.length} timers listed.`, "Pass --all to see loaded but inactive timers, too."]));
  }
  if (verb === "list-unit-files") {
    const types = (values.get("type") ?? values.get("t"))?.split(",");
    const states = values.get("state")?.split(",");
    const patterns = names.map((n) => globToRegExp(unitName(n)));
    const shown = all.filter(
      (s) =>
        (!types || types.includes("service")) &&
        (!states || states.includes(s.enabled ? "enabled" : "disabled")) &&
        (!patterns.length || patterns.some((p) => p.test(`${s.name}.service`))),
    );
    const rows = shown.map((s) => [`${s.name}.service`, s.enabled ? "enabled" : "disabled", "enabled"]);
    if (flags.has("no-legend")) return ok(lines(table(rows)));
    return ok(lines([...table([["UNIT FILE", "STATE", "PRESET"], ...rows]), "", `${shown.length} unit files listed.`]));
  }

  if (verb === "status") {
    if (!names.length) {
      const failed = all.filter((s) => s.state === "failed").length;
      return ok(
        lines([
          `● ${host.name}`,
          `    State: ${failed ? "degraded" : "running"}`,
          `    Units: ${all.length + 180} loaded (incl. loaded aliases)`,
          "     Jobs: 0 queued",
          `   Failed: ${failed} units`,
          `    Since: ${systemdTime(host.bootAt)}; ${ago(host.now() - host.bootAt)}`,
          "  systemd: 255.4-1ubuntu8",
          "   CGroup: /",
        ]),
      );
    }
    const count = Number(values.get("lines") ?? values.get("n") ?? 10);
    const blocks: string[] = [];
    const errors: string[] = [];
    let code = 0;
    for (const { raw, service } of resolveUnits(host, names)) {
      if (!service) {
        errors.push(`Unit ${unitName(raw)} could not be found.`);
        code = 4;
        continue;
      }
      blocks.push(lines(statusOf(host, service, Number.isFinite(count) ? count : 10)));
      if (service.state !== "active" && code === 0) code = 3;
    }
    return { out: blocks.join("\n"), err: lines(errors), code };
  }

  if (JOB_VERBS.includes(verb)) {
    if (!names.length) return fail("Too few arguments.\n", 1);
    const units = resolveUnits(host, names);
    if (!ctx.root) {
      const first = unitName(units[0]?.raw ?? names[0]);
      return fail(lines([`Failed to ${verb} ${first}: Interactive authentication required.`, `See system logs and 'systemctl status ${first}' for details.`]), 1);
    }
    const errors: string[] = [];
    let code = 0;
    for (const { raw, service } of units) {
      const unit = unitName(raw);
      if (!service) {
        errors.push(`Failed to ${verb} ${unit}: Unit ${unit} not found.`);
        code = 5;
        continue;
      }
      let why: string | undefined;
      const running = service.state === "active";
      if (verb === "start") why = host.start(service.name);
      else if (verb === "stop") why = host.stop(service.name);
      else if (verb === "restart") why = host.restart(service.name);
      else if (verb === "try-restart" || verb === "condrestart") why = running ? host.restart(service.name) : undefined;
      else if (verb === "reload") {
        if (!running) {
          errors.push(`${unit} is not active, cannot reload.`);
          code = 1;
          continue;
        }
        why = host.reload(service.name);
      } else if (verb === "reload-or-restart" || verb === "force-reload") why = running ? host.reload(service.name) : host.start(service.name);
      else if (verb === "try-reload-or-restart") why = running ? host.reload(service.name) : undefined;
      else if (verb === "kill") {
        if (running) {
          host.log("systemd", `${unit}: Main process exited, code=killed, status=15/TERM`, 5);
          host.stop(service.name);
        }
      }
      if (why) {
        errors.push(
          `Job for ${unit} failed because the control process exited with error code.`,
          `See "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.`,
        );
        code = 1;
      }
    }
    return { out: "", err: lines(errors), code };
  }

  if (verb === "is-active" || verb === "is-failed") {
    if (!names.length) return fail("Too few arguments.\n", 1);
    const found = resolveUnits(host, names);
    const states = found.map((u) => u.service?.state ?? "inactive");
    const wanted = verb === "is-active" ? "active" : "failed";
    const code = states.includes(wanted) ? 0 : verb === "is-active" ? (found.some((u) => !u.service) ? 4 : 3) : 1;
    return { out: quiet ? "" : lines(states), err: "", code };
  }

  if (verb === "is-enabled") {
    if (!names.length) return fail("Too few arguments.\n", 1);
    const out: string[] = [];
    const errors: string[] = [];
    let any = false;
    for (const { raw, service } of resolveUnits(host, names)) {
      if (!service) errors.push(`Failed to get unit file state for ${unitName(raw)}: No such file or directory`);
      else {
        out.push(service.enabled ? "enabled" : "disabled");
        any ||= service.enabled;
      }
    }
    return { out: quiet ? "" : lines(out), err: lines(errors), code: any ? 0 : 1 };
  }

  if (verb === "enable" || verb === "disable") {
    if (!names.length) return fail("Too few arguments.\n", 1);
    const units = resolveUnits(host, names);
    const missing = units.find((u) => !u.service);
    if (missing) return fail(`Failed to ${verb} unit: Unit file ${unitName(missing.raw)} does not exist.\n`, 1);
    if (!ctx.root) return fail(`Failed to ${verb} unit: Interactive authentication required.\n`, 1);
    const notes: string[] = [];
    let code = 0;
    for (const { service } of units) {
      if (!service) continue;
      const unit = `${service.name}.service`;
      const link = `/etc/systemd/system/multi-user.target.wants/${unit}`;
      if (verb === "enable" && !service.enabled) notes.push(`Created symlink ${link} → ${unitPath(host, service)}.`);
      if (verb === "disable" && service.enabled) notes.push(`Removed "${link}".`);
      // The host keeps no method for this: whether a unit starts at boot is a field of the service.
      service.enabled = verb === "enable";
      if (flags.has("now")) {
        const why = verb === "enable" ? host.start(service.name) : host.stop(service.name);
        if (why) {
          notes.push(`Job for ${unit} failed because the control process exited with error code.`, `See "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.`);
          code = 1;
        }
      }
    }
    return { out: "", err: quiet ? "" : lines(notes), code };
  }

  if (verb === "daemon-reload" || verb === "daemon-reexec") {
    return ctx.root ? ok() : fail(`Failed to ${verb === "daemon-reload" ? "reload" : "reexecute"} daemon: Interactive authentication required.\n`, 1);
  }

  if (verb === "reset-failed") {
    if (!ctx.root) return fail("Failed to reset failed state: Interactive authentication required.\n", 1);
    const units = names.length ? resolveUnits(host, names) : all.map((service) => ({ raw: service.name, service }));
    const errors: string[] = [];
    for (const { raw, service } of units) {
      if (!service) errors.push(`Failed to reset failed state of unit ${unitName(raw)}: Unit ${unitName(raw)} not loaded.`);
      else if (service.state === "failed") service.state = "inactive";
    }
    return { out: "", err: lines(errors), code: errors.length ? 1 : 0 };
  }

  if (verb === "show") {
    if (!names.length) throw new NotSimulated("systemctl show without a unit");
    const wanted = [...optionValues(args, "p", "property")].flatMap((v) => v.split(","));
    const blocks: string[] = [];
    for (const { raw, service } of resolveUnits(host, names)) {
      const unit = unitName(raw);
      const props: [string, string][] = service
        ? [
            ["Id", unit],
            ["Names", unit],
            ["Description", service.description],
            ["LoadState", "loaded"],
            ["ActiveState", service.state],
            ["SubState", subState(service)],
            ["UnitFileState", service.enabled ? "enabled" : "disabled"],
            ["UnitFilePreset", "enabled"],
            ["FragmentPath", unitPath(host, service)],
            ["Type", "simple"],
            ["Restart", "on-failure"],
            ["MainPID", String(service.pid ?? 0)],
            ["ExecMainPID", String(service.pid ?? 0)],
            ["ExecMainStatus", service.state === "failed" ? "1" : "0"],
            ["Result", service.state === "failed" ? "exit-code" : "success"],
            ["User", service.user ?? "root"],
            ["NRestarts", "0"],
            ["ActiveEnterTimestamp", service.state === "active" ? systemdTime(service.since) : ""],
            ["InactiveEnterTimestamp", service.state === "active" ? "" : systemdTime(service.since)],
            ["StateChangeTimestamp", systemdTime(service.since)],
          ]
        : [
            ["Id", unit],
            ["Names", unit],
            ["Description", unit],
            ["LoadState", "not-found"],
            ["ActiveState", "inactive"],
            ["SubState", "dead"],
            ["MainPID", "0"],
            ["Result", "success"],
          ];
      const picked = wanted.length ? wanted.flatMap((w) => props.filter(([k]) => k === w)) : props;
      blocks.push(lines(picked.map(([k, v]) => (flags.has("value") ? v : `${k}=${v}`))));
    }
    return ok(blocks.join("\n"));
  }

  if (verb === "cat") {
    if (!names.length) return fail("Too few arguments.\n", 1);
    const blocks: string[] = [];
    const errors: string[] = [];
    for (const { raw, service } of resolveUnits(host, names)) {
      if (service) blocks.push(unitFile(host, service));
      else errors.push(`No files found for ${unitName(raw)}.`);
    }
    return { out: blocks.join("\n"), err: lines(errors), code: errors.length ? 1 : 0 };
  }

  throw new NotSimulated(`systemctl ${verb}`);
}

function service(ctx: SimContext, args: string[]): SimResult {
  if (args[0] === "--status-all") {
    const all = [...ctx.host.services.values()].sort((a, b) => a.name.localeCompare(b.name));
    return ok(lines(all.map((s) => ` [ ${s.state === "active" ? "+" : "-"} ]  ${s.name}`)));
  }
  const [name, action] = args;
  if (!name || !action) return fail("Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n", 1);
  if (!["status", "start", "stop", "restart", "reload", "force-reload", "try-restart"].includes(action)) throw new NotSimulated(`service ${name} ${action}`);
  if (action !== "status" && !findService(ctx.host, name)) return fail(`Failed to ${action} ${unitName(name)}: Unit ${unitName(name)} not found.\n`, 5);
  return systemctl(ctx, [action, name]);
}

// ---- journalctl --------------------------------------------------------------

const PRIORITIES: Record<string, number> = { emerg: 0, alert: 1, crit: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 };
const priorityOf = (text: string): number | undefined => (/^[0-7]$/.test(text) ? Number(text) : PRIORITIES[text.toLowerCase()]);

/** A time as journalctl takes one: `today`, `10 min ago`, `-1h`, `2026-11-13 18:00`. */
export function parseTimestamp(text: string, now: number): number | undefined {
  const t = text.trim().toLowerCase();
  if (t === "now") return now;
  if (t === "today") return startOfDay(now);
  if (t === "yesterday") return startOfDay(now) - 86_400_000;
  if (t === "tomorrow") return startOfDay(now) + 86_400_000;
  const unitMs = (unit: string): number | undefined => {
    if (/^(s|sec|secs|second|seconds)$/.test(unit)) return 1000;
    if (/^(m|min|mins|minute|minutes)$/.test(unit)) return 60_000;
    if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return 3_600_000;
    if (/^(d|day|days)$/.test(unit)) return 86_400_000;
    if (/^(w|week|weeks)$/.test(unit)) return 7 * 86_400_000;
    return undefined;
  };
  const isAgo = t.endsWith(" ago");
  const relative = /^([-+]?)\s*(\d+)\s*([a-z]+)$/.exec(isAgo ? t.slice(0, -4).trim() : t);
  if (relative && (relative[1] || isAgo)) {
    const ms = unitMs(relative[3]);
    if (ms === undefined) return undefined;
    return relative[1] === "+" ? now + Number(relative[2]) * ms : now - Number(relative[2]) * ms;
  }
  const [day, time, ...more] = t.split(/[ t]+/);
  const dayParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const clock = /^(\d{1,2}):(\d{2})(:\d\d|)$/.exec(dayParts ? (time ?? "0:00") : day);
  if (more.length || !clock || (!dayParts && time !== undefined)) return undefined;
  const base = dayParts ? Date.UTC(Number(dayParts[1]), Number(dayParts[2]) - 1, Number(dayParts[3])) : startOfDay(now);
  return base + Number(clock[1]) * 3_600_000 + Number(clock[2]) * 60_000 + Number(clock[3].slice(1) || 0) * 1000;
}

const JOURNAL_SHORT_VALUES: Record<string, string> = { u: "unit", n: "lines", p: "priority", S: "since", U: "until", g: "grep", o: "output", t: "identifier", D: "directory", c: "cursor" };
const JOURNAL_LONG_VALUES = ["unit", "lines", "priority", "since", "until", "grep", "output", "identifier", "directory", "cursor", "facility", "boot"];

function journalctl(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const units: string[] = [];
  const idents: string[] = [];
  const flags = new Set<string>();
  const single = new Map<string, string>();
  const take = (key: string, value: string): void => {
    if (key === "unit") units.push(value);
    else if (key === "identifier") idents.push(value);
    else single.set(key, value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) take(key, a.slice(eq + 1));
      else if (key === "lines" || key === "boot") {
        // Both may stand alone: a number after them is theirs, anything else is not.
        if (/^([+-]?\d+|all)$/.test(args[i + 1] ?? "")) take(key, args[++i]);
        else flags.add(key);
      } else if (JOURNAL_LONG_VALUES.includes(key) && i + 1 < args.length) take(key, args[++i]);
      else flags.add(key);
      continue;
    }
    if (/^-\d+$/.test(a)) {
      single.set("lines", a.slice(1));
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const long = JOURNAL_SHORT_VALUES[c];
        if (c === "n" || c === "b") {
          const attached = a.slice(j + 1);
          const key = c === "n" ? "lines" : "boot";
          if (/^([+-]?\d+|all)$/.test(attached)) {
            take(key, attached);
            break;
          }
          if (!attached && /^([+-]?\d+|all)$/.test(args[i + 1] ?? "")) take(key, args[++i]);
          else flags.add(key);
          continue;
        }
        if (long) {
          const value = a.slice(j + 1) || args[++i];
          if (value !== undefined) take(long, value);
          break;
        }
        flags.add(c);
      }
      continue;
    }
    const match = /^_SYSTEMD_UNIT=(.+)$/.exec(a) ?? /^SYSLOG_IDENTIFIER=(.+)$/.exec(a);
    if (!match) throw new NotSimulated(`journalctl ${a}`);
    if (a.startsWith("_")) units.push(match[1]);
    else idents.push(match[1]);
  }
  if (flags.has("disk-usage")) return ok("Archived and active journals take up 48.0M in the file system.\n");
  if (flags.has("list-boots")) return ok(lines(["IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY", `  0 ${hex(`boot${host.bootAt}`, 32)} ${systemdTime(host.bootAt)} ${systemdTime(host.now())}`]));
  for (const f of flags) if (f.startsWith("vacuum") || f === "rotate" || f === "flush" || f === "verify") throw new NotSimulated(`journalctl --${f}`);
  for (const key of single.keys()) if (key.startsWith("vacuum")) throw new NotSimulated(`journalctl --${key}`);

  const now = host.now();
  let since: number | undefined;
  let until: number | undefined;
  for (const key of ["since", "until"] as const) {
    const text = single.get(key);
    if (text === undefined) continue;
    const at = parseTimestamp(text, now);
    if (at === undefined) return fail(`Failed to parse timestamp: ${text}\n`, 1);
    if (key === "since") since = at;
    else until = at;
  }
  if (flags.has("b") || flags.has("boot") || single.get("boot") === "0") since = Math.max(since ?? 0, host.bootAt);
  else if (single.has("boot")) return fail(`Data from the specified boot (${single.get("boot")}) is not available: No such boot ID in journal\n`, 1);

  let low = 0;
  let high = 7;
  const priority = single.get("priority");
  if (priority !== undefined) {
    const [a, b] = priority.split("..");
    const first = priorityOf(a);
    const second = b === undefined ? undefined : priorityOf(b);
    if (first === undefined || (b !== undefined && second === undefined)) return fail(`Unknown log level ${priority}\n`, 1);
    if (second === undefined) high = first;
    else [low, high] = [Math.min(first, second), Math.max(first, second)];
  }

  let pattern: RegExp | undefined;
  const grep = single.get("grep");
  if (grep !== undefined) {
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern is what the person asked to search for, as journalctl takes it
      pattern = new RegExp(grep, grep === grep.toLowerCase() ? "i" : "");
    } catch {
      return fail(`Failed to compile pattern: ${grep}\n`, 1);
    }
  }

  let found = sortedJournal(host).filter((line) => {
    const p = line.priority ?? 6;
    if (p < low || p > high) return false;
    if (since !== undefined && line.at < since) return false;
    if (until !== undefined && line.at > until) return false;
    if (units.length && !units.some((u) => ofUnit(line, u))) return false;
    if (idents.length && !idents.includes(line.unit)) return false;
    if ((flags.has("k") || flags.has("dmesg")) && line.unit !== "kernel") return false;
    if (pattern && !pattern.test(line.text)) return false;
    return true;
  });

  const wanted = single.get("lines");
  let count: number | undefined;
  if (wanted !== undefined && wanted !== "all") count = Math.abs(Number(wanted));
  else if (wanted === undefined && (flags.has("n") || flags.has("lines") || flags.has("f") || flags.has("follow"))) count = 10;
  else if (wanted === undefined && (flags.has("e") || flags.has("pager-end"))) count = 1000;
  if (count !== undefined) found = wanted?.startsWith("+") ? found.slice(0, count) : count === 0 ? [] : found.slice(-count);
  if (flags.has("r") || flags.has("reverse")) found = [...found].reverse();

  if (!found.length) return { out: flags.has("q") || flags.has("quiet") ? "" : "-- No entries --\n", err: "", code: pattern ? 1 : 0 };
  const output = single.get("output") ?? "short";
  if (output === "cat") return ok(lines(found.map((l) => l.text)));
  if (output === "short" || output === "short-full" || output === "with-unit") return ok(lines(found.flatMap((l) => journalShort(host, l))));
  if (output === "short-iso") {
    return ok(lines(found.flatMap((l) => l.text.split("\n").map((text) => `${ymd(l.at)}T${hms(l.at)}+00:00 ${host.name} ${journalIdent(host, l.unit)}: ${text}`))));
  }
  if (output === "short-unix") {
    return ok(lines(found.map((l) => `${(l.at / 1000).toFixed(6)} ${host.name} ${journalIdent(host, l.unit)}: ${l.text}`)));
  }
  if (output === "json") {
    return ok(
      lines(
        found.map((l) =>
          JSON.stringify({
            __REALTIME_TIMESTAMP: String(l.at * 1000),
            _HOSTNAME: host.name,
            PRIORITY: String(l.priority ?? 6),
            SYSLOG_IDENTIFIER: l.unit,
            ...(l.unit === "kernel" ? { _TRANSPORT: "kernel" } : { _SYSTEMD_UNIT: l.unit === "systemd" ? "init.scope" : unitName(l.unit) }),
            MESSAGE: l.text,
          }),
        ),
      ),
    );
  }
  throw new NotSimulated(`journalctl -o ${output}`);
}

// ---- disks -------------------------------------------------------------------

function df(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { flags, values, rest } = parseArgs(args, ["t", "x", "B", "type", "exclude-type", "block-size", "output"]);
  if (values.has("B") || values.has("block-size") || values.has("output")) throw new NotSimulated("df with a block size or a column list");
  const human = flags.has("h") || flags.has("H") || flags.has("human-readable");
  const withType = flags.has("T") || flags.has("print-type");
  const inodes = flags.has("i") || flags.has("inodes");
  const only = values.get("t") ?? values.get("type");
  const except = values.get("x") ?? values.get("exclude-type");
  const errors: string[] = [];
  let disks: SimDisk[] = [];
  if (rest.length) {
    for (const path of rest) {
      const target = normalizePath(path, ctx.cwd);
      // A mount point is there whether or not the scenario keeps anything under it.
      const disk = host.exists(target) || host.disks.some((d) => d.mount === target) ? host.diskOf(target) : undefined;
      if (disk) disks.push(disk);
      else errors.push(`df: ${path}: No such file or directory`);
    }
  } else disks = [...host.disks].sort((a, b) => a.mount.localeCompare(b.mount));
  disks = disks.filter((d) => (!only || d.fs === only) && (!except || d.fs !== except));

  const megabytes = flags.has("m");
  const amount = (kb: number): string => (human ? (kb === 0 ? "0" : humanCeil(kb * 1024)) : megabytes ? String(Math.ceil(kb / 1024)) : String(kb));
  const head = inodes ? ["Inodes", "IUsed", "IFree", "IUse%"] : human ? ["Size", "Used", "Avail", "Use%"] : [megabytes ? "1M-blocks" : "1K-blocks", "Used", "Available", "Use%"];
  const rows = disks.map((disk) => {
    const use = host.diskUse(disk);
    if (inodes) {
      const total = Math.floor(disk.sizeKb / 16);
      let files = 0;
      for (const path of host.files.keys()) if (host.diskOf(path) === disk) files++;
      const used = Math.min(total, Math.floor(disk.baseUsedKb / 48) + files);
      return { disk, cells: [String(total), String(used), String(total - used), `${total ? Math.ceil((used / total) * 100) : 0}%`] };
    }
    return { disk, cells: [amount(disk.sizeKb), amount(use.usedKb), amount(use.availKb), `${use.pct}%`] };
  });
  if (flags.has("total") && rows.length && !inodes) {
    const sum = disks.reduce((t, d) => ({ size: t.size + d.sizeKb, used: t.used + host.diskUse(d).usedKb }), { size: 0, used: 0 });
    rows.push({
      disk: { device: "total", fs: "-", mount: "-", sizeKb: sum.size, baseUsedKb: 0 },
      cells: [amount(sum.size), amount(sum.used), amount(sum.size - sum.used), `${Math.ceil((sum.used / sum.size) * 100)}%`],
    });
  }
  const fsWidth = Math.max(14, ...rows.map((r) => r.disk.device.length));
  const typeWidth = Math.max(4, ...rows.map((r) => r.disk.fs.length));
  const widths = head.map((h, i) => Math.max(human && !inodes && i < 3 ? 5 : h.length, ...rows.map((r) => r.cells[i].length)));
  const line = (device: string, fs: string, cells: string[], mount: string): string =>
    [device.padEnd(fsWidth), ...(withType ? [fs.padEnd(typeWidth)] : []), ...cells.map((c, i) => c.padStart(widths[i])), mount].join(" ");
  const out = rows.length || !errors.length ? [line("Filesystem", "Type", head, "Mounted on"), ...rows.map((r) => line(r.disk.device, r.disk.fs, r.cells, r.disk.mount))] : [];
  return { out: lines(out), err: lines(errors), code: errors.length ? 1 : 0 };
}

function free(ctx: SimContext, args: string[]): SimResult {
  const { flags } = parseArgs(args, ["s", "c"]);
  const m = memory(ctx.host);
  const show = (kb: number): string => {
    if (flags.has("h") || flags.has("human")) return humanIec(kb);
    if (flags.has("b") || flags.has("bytes")) return String(kb * 1024);
    if (flags.has("m") || flags.has("mebi")) return String(Math.floor(kb / 1024));
    if (flags.has("g") || flags.has("gibi")) return String(Math.floor(kb / 1_048_576));
    return String(kb);
  };
  const row = (label: string, cells: (number | string)[]): string => `${label.padEnd(8)}${cells.map((c) => (typeof c === "number" ? show(c) : c).padStart(12)).join("")}`;
  const out = [
    row("", ["total", "used", "free", "shared", "buff/cache", "available"]),
    row("Mem:", [m.total, m.used, m.free, m.shared, m.cache, m.available]),
    row("Swap:", [m.swap, 0, m.swap]),
  ];
  if (flags.has("t") || flags.has("total")) out.push(row("Total:", [m.total + m.swap, m.used, m.free + m.swap]));
  return ok(lines(out));
}

function lsblk(ctx: SimContext): SimResult {
  const { host } = ctx;
  interface Block { name: string; sizeKb: number; type: string; mount: string; children: Block[] }
  const tops = new Map<string, Block>();
  for (const disk of host.disks) {
    if (!disk.device.startsWith("/dev/")) continue;
    const name = disk.device.slice(disk.device.lastIndexOf("/") + 1);
    if (disk.device.startsWith("/dev/mapper/")) {
      tops.set(name, { name, sizeKb: disk.sizeKb, type: "lvm", mount: disk.mount, children: [] });
      continue;
    }
    const parent = /^(nvme\d+n\d+|mmcblk\d+)p\d+$/.exec(name)?.[1] ?? /^([a-z]+)\d+$/.exec(name)?.[1];
    if (!parent) {
      tops.set(name, { name, sizeKb: disk.sizeKb, type: "disk", mount: disk.mount, children: [] });
      continue;
    }
    const top = tops.get(parent) ?? { name: parent, sizeKb: 0, type: "disk", mount: "", children: [] };
    top.sizeKb += disk.sizeKb;
    top.children.push({ name, sizeKb: disk.sizeKb, type: "part", mount: disk.mount, children: [] });
    tops.set(parent, top);
  }
  const rows: string[][] = [["NAME", "MAJ:MIN", "RM", "SIZE", "RO", "TYPE", "MOUNTPOINTS"]];
  let major = 0;
  for (const top of [...tops.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const maj = top.type === "lvm" ? 252 : top.name.startsWith("nvme") ? 259 : 8;
    const min = top.type === "lvm" ? major++ : 0;
    rows.push([top.name, `${maj}:${min}`, "0", humanCeil(top.sizeKb * 1024), "0", top.type, top.mount]);
    top.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    top.children.forEach((child, i) => {
      rows.push([`${i === top.children.length - 1 ? "└─" : "├─"}${child.name}`, `${maj}:${i + 1}`, "0", humanCeil(child.sizeKb * 1024), "0", child.type, child.mount]);
    });
  }
  return ok(lines(table(rows, [1, 2, 3, 4])));
}

const mountOptions = (disk: SimDisk): string => (disk.fs === "tmpfs" ? "rw,nosuid,nodev" : "rw,relatime");

function mount(ctx: SimContext, args: string[]): SimResult {
  const { flags, rest } = parseArgs(args, ["t", "o"]);
  if (rest.length || flags.has("a")) throw new NotSimulated("mounting a filesystem");
  const disks = [...ctx.host.disks].sort((a, b) => a.mount.localeCompare(b.mount));
  return ok(
    lines([
      "sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)",
      "proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)",
      "udev on /dev type devtmpfs (rw,nosuid,relatime)",
      "tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime)",
      ...disks.map((d) => `${d.device} on ${d.mount} type ${d.fs} (${mountOptions(d)})`),
    ]),
  );
}

function findmnt(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { rest } = parseArgs(args, ["t", "o", "S", "T"]);
  const all = [...host.disks].sort((a, b) => a.mount.localeCompare(b.mount));
  const head = ["TARGET", "SOURCE", "FSTYPE", "OPTIONS"];
  if (rest.length) {
    const wanted = rest[0];
    const disk = all.find((d) => d.mount === normalizePath(wanted, ctx.cwd) || d.device === wanted);
    if (!disk) return fail("", 1);
    return ok(lines(table([head, [disk.mount, disk.device, disk.fs, mountOptions(disk)]])));
  }
  const below = all.filter((d) => d.mount !== "/");
  const rows = all.map((d) => [d.mount === "/" ? "/" : `${below.indexOf(d) === below.length - 1 ? "└─" : "├─"}${d.mount}`, d.device, d.fs, mountOptions(d)]);
  return ok(lines(table([head, ...rows])));
}

// ---- who and where -----------------------------------------------------------

function hostname(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { flags, rest } = parseArgs(args);
  if (rest.length) throw new NotSimulated("changing the host name");
  if (flags.has("I") || flags.has("all-ip-addresses")) return ok(`${host.address} \n`);
  if (flags.has("i") || flags.has("ip-address")) return ok(`${host.address}\n`);
  if (flags.has("s") || flags.has("short")) return ok(`${host.name.split(".")[0]}\n`);
  if (flags.has("d") || flags.has("domain")) return ok(`${host.name.split(".").slice(1).join(".")}\n`);
  return ok(`${host.name}\n`);
}

function hostnamectl(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  if (args.length && args[0] !== "status") throw new NotSimulated(`hostnamectl ${args[0]}`);
  return ok(
    lines([
      ` Static hostname: ${host.name}`,
      "       Icon name: computer-vm",
      "         Chassis: vm",
      `      Machine ID: ${hex(`machine${host.name}`, 32)}`,
      `         Boot ID: ${hex(`boot${host.bootAt}`, 32)}`,
      "  Virtualization: kvm",
      `Operating System: ${host.os.pretty}`,
      `          Kernel: Linux ${host.kernel}`,
      "    Architecture: x86-64",
      " Hardware Vendor: QEMU",
      "  Hardware Model: Standard PC _Q35 + ICH9, 2009_",
    ]),
  );
}

function uname(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { flags } = parseArgs(args);
  const long: Record<string, string> = { "kernel-name": "s", nodename: "n", "kernel-release": "r", "kernel-version": "v", machine: "m", processor: "p", "hardware-platform": "i", "operating-system": "o", all: "a" };
  const asked = new Set([...flags].map((f) => long[f] ?? f));
  const build = /-(\d+)-/.exec(host.kernel)?.[1] ?? "1";
  const parts: [string, string][] = [
    ["s", "Linux"],
    ["n", host.name],
    ["r", host.kernel],
    ["v", `#${build}-${distributor(host)} SMP PREEMPT_DYNAMIC ${strftime(host.bootAt - 38 * 86_400_000, "%a %b %e %H:%M:%S UTC %Y")}`],
    ["m", "x86_64"],
    ["p", "x86_64"],
    ["i", "x86_64"],
    ["o", "GNU/Linux"],
  ];
  if (!asked.size) asked.add("s");
  for (const f of asked) if (f !== "a" && !parts.some(([k]) => k === f)) return fail(`uname: invalid option -- '${f}'\nTry 'uname --help' for more information.\n`, 1);
  return ok(`${parts.filter(([k]) => asked.has("a") || asked.has(k)).map(([, v]) => v).join(" ")}\n`);
}

function date(ctx: SimContext, args: string[]): SimResult {
  const now = ctx.host.now();
  let format: string | undefined;
  let iso: string | undefined;
  let rfc = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("+")) format = a.slice(1);
    else if (a === "-u" || a === "--utc" || a === "--universal") continue;
    else if (a === "-R" || a === "--rfc-email") rfc = true;
    else if (a.startsWith("-I")) iso = a.slice(2) || "date";
    else if (a.startsWith("--iso-8601")) iso = a.includes("=") ? a.slice(a.indexOf("=") + 1) : "date";
    else if (a === "-d" || a.startsWith("--date") || a === "-r" || a.startsWith("--reference")) throw new NotSimulated("date for another time than now");
    else if (a === "-s" || a.startsWith("--set")) {
      if (!ctx.root) return fail("date: cannot set date: Operation not permitted\n", 1);
      throw new NotSimulated("setting the clock");
    } else return fail(`date: invalid date ‘${a}’\n`, 1);
  }
  if (format !== undefined) return ok(`${strftime(now, format)}\n`);
  if (rfc) return ok(`${strftime(now, "%a, %d %b %Y %H:%M:%S +0000")}\n`);
  if (iso !== undefined) {
    if (iso === "date") return ok(`${ymd(now)}\n`);
    if (iso === "hours") return ok(`${ymd(now)}T${hms(now).slice(0, 2)}+00:00\n`);
    if (iso === "minutes") return ok(`${ymd(now)}T${hms(now).slice(0, 5)}+00:00\n`);
    if (iso === "seconds") return ok(`${ymd(now)}T${hms(now)}+00:00\n`);
    if (iso === "ns") return ok(`${ymd(now)}T${hms(now)},${strftime(now, "%N")}+00:00\n`);
    return fail(`date: invalid argument ‘${iso}’ for ‘--iso-8601’\n`, 1);
  }
  return ok(`${strftime(now, "%a %b %e %H:%M:%S UTC %Y")}\n`);
}

function timedatectl(ctx: SimContext, args: string[]): SimResult {
  if (args.length && args[0] !== "status") throw new NotSimulated(`timedatectl ${args[0]}`);
  const now = ctx.host.now();
  return ok(
    lines([
      `               Local time: ${systemdTime(now)}`,
      `           Universal time: ${systemdTime(now)}`,
      `                 RTC time: ${systemdTime(now).replace(/ UTC$/, "")}`,
      "                Time zone: Etc/UTC (UTC, +0000)",
      "System clock synchronized: yes",
      "              NTP service: active",
      "          RTC in local TZ: no",
    ]),
  );
}

/** A number for a system account, the same every time: service users are made in the 100s. */
const systemUid = (name: string): number => 100 + (hash(name) % 800);

function knownUsers(host: SimHost): Map<string, { uid: number; groups: [number, string][] }> {
  const users = new Map<string, { uid: number; groups: [number, string][] }>();
  users.set("root", { uid: 0, groups: [[0, "root"]] });
  users.set(host.user, host.user === "root" ? { uid: 0, groups: [[0, "root"]] } : { uid: 1000, groups: [[1000, host.user], [4, "adm"], [27, "sudo"]] });
  for (const service of host.services.values()) {
    if (service.user && !users.has(service.user)) users.set(service.user, { uid: systemUid(service.user), groups: [[systemUid(service.user), service.user]] });
  }
  for (const p of host.processes) if (!users.has(p.user)) users.set(p.user, { uid: systemUid(p.user), groups: [[systemUid(p.user), p.user]] });
  return users;
}

function id(ctx: SimContext, args: string[]): SimResult {
  const { flags, rest } = parseArgs(args);
  const name = rest[0] ?? ctx.user;
  const user = knownUsers(ctx.host).get(name);
  if (!user) return fail(`id: ‘${name}’: no such user\n`, 1);
  const names = flags.has("n") || flags.has("name");
  if (flags.has("u") || flags.has("user")) return ok(`${names ? name : user.uid}\n`);
  if (flags.has("g") || flags.has("group")) return ok(`${names ? user.groups[0][1] : user.groups[0][0]}\n`);
  if (flags.has("G") || flags.has("groups")) return ok(`${user.groups.map(([gid, group]) => (names ? group : gid)).join(" ")}\n`);
  const [gid, group] = user.groups[0];
  return ok(`uid=${user.uid}(${name}) gid=${gid}(${group}) groups=${user.groups.map(([g, n]) => `${g}(${n})`).join(",")}\n`);
}

function who(ctx: SimContext): SimResult {
  const { host } = ctx;
  const at = loginAt(host);
  return ok(`${host.user.padEnd(8)} pts/0        ${ymd(at)} ${hms(at).slice(0, 5)} (${clientAddress(host)})\n`);
}

function w(ctx: SimContext): SimResult {
  const { host } = ctx;
  return ok(
    lines([
      uptimeLine(host),
      "USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT",
      `${host.user.padEnd(8)} pts/0    ${clientAddress(host).padEnd(16)} ${hms(loginAt(host)).slice(0, 5)}    0.00s  0.04s  0.00s w`,
    ]),
  );
}

function last(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { rest } = parseArgs(args, ["n"]);
  const rows = [
    `${host.user.padEnd(8)} pts/0        ${clientAddress(host).padEnd(16)} ${lastTime(loginAt(host))}   still logged in`,
    `${host.user.padEnd(8)} pts/0        ${clientAddress(host).padEnd(16)} ${lastTime(loginAt(host) - 26 * 3_600_000)} - ${hms(loginAt(host) - 25 * 3_600_000).slice(0, 5)}  (01:00)`,
    `reboot   system boot  ${host.kernel.padEnd(16)} ${lastTime(host.bootAt)}   still running`,
  ].filter((row) => !rest.length || rest.some((user) => row.startsWith(`${user} `)));
  return ok(lines([...rows, "", `wtmp begins ${strftime(host.bootAt, "%a %b %e %H:%M:%S %Y")}`]));
}

function lastlog(ctx: SimContext): SimResult {
  const { host } = ctx;
  const rows = [...knownUsers(host).keys()].map((name) =>
    name === host.user
      ? `${name.padEnd(16)} pts/0    ${clientAddress(host).padEnd(16)} ${strftime(loginAt(host), "%a %b %e %H:%M:%S +0000 %Y")}`
      : `${name.padEnd(16)}                           **Never logged in**`,
  );
  return ok(lines(["Username         Port     From             Latest", ...rows]));
}

// ---- the shell's own words ---------------------------------------------------

const BUILTINS = new Set(["cd", "export", "unset", "alias", "unalias", "set", "umask", "ulimit", "history", "exit", "logout", "type", "command", "echo", "pwd", "source", "true", "false", "test", "printf", "read", "kill"]);
/** What the shell answers by itself, before it looks at its commands. */
const SHELL_OWN = new Set(["cd", "sudo", "sh", "bash"]);

const hasCommand = (ctx: SimContext, name: string): boolean => ctx.shell.has(name) || SHELL_OWN.has(name);
const pathOf = (name: string): string => `/usr/bin/${name}`;

function which(ctx: SimContext, args: string[]): SimResult {
  const names = args.filter((a) => !a.startsWith("-"));
  if (!names.length) return fail("", 1);
  const out: string[] = [];
  let code = 0;
  for (const name of names) {
    if (name !== "cd" && hasCommand(ctx, name)) out.push(pathOf(name));
    else code = 1;
  }
  return { out: lines(out), err: "", code };
}

function command(ctx: SimContext, args: string[]): SimResult {
  if (args[0] !== "-v" && args[0] !== "-V") throw new NotSimulated("command without -v");
  const out: string[] = [];
  let code = 0;
  for (const name of args.slice(1)) {
    if (!hasCommand(ctx, name)) code = 1;
    else if (BUILTINS.has(name)) out.push(args[0] === "-V" ? `${name} is a shell builtin` : name);
    else out.push(args[0] === "-V" ? `${name} is ${pathOf(name)}` : pathOf(name));
  }
  return { out: lines(out), err: "", code };
}

function type(ctx: SimContext, args: string[]): SimResult {
  const { flags, rest } = parseArgs(args);
  const out: string[] = [];
  const errors: string[] = [];
  for (const name of rest) {
    const builtin = BUILTINS.has(name) && hasCommand(ctx, name);
    if (!hasCommand(ctx, name)) {
      if (!flags.has("t") && !flags.has("p") && !flags.has("P")) errors.push(`bash: type: ${name}: not found`);
      else errors.push("");
    } else if (flags.has("t")) out.push(builtin ? "builtin" : "file");
    else if (flags.has("p") || flags.has("P")) {
      if (!builtin || flags.has("P")) out.push(pathOf(name));
    } else out.push(builtin ? `${name} is a shell builtin` : `${name} is ${pathOf(name)}`);
  }
  return { out: lines(out), err: lines(errors.filter(Boolean)), code: errors.length ? 1 : 0 };
}

function environment(ctx: SimContext): [string, string][] {
  const { host } = ctx;
  const home = ctx.shell.home(ctx.user);
  const path = ctx.root ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin" : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin";
  return [
    ["SHELL", "/bin/bash"],
    ["PWD", ctx.cwd],
    ["LOGNAME", ctx.user],
    ["HOME", home],
    ["LANG", "C.UTF-8"],
    ["TERM", "xterm-256color"],
    ["USER", ctx.user],
    ["SHLVL", "1"],
    ...(ctx.root
      ? ([["SUDO_COMMAND", "/usr/bin/env"], ["SUDO_USER", host.user], ["SUDO_UID", "1000"], ["SUDO_GID", "1000"]] as [string, string][])
      : ([
          ["XDG_SESSION_TYPE", "tty"],
          ["XDG_RUNTIME_DIR", "/run/user/1000"],
          ["SSH_CLIENT", `${clientAddress(host)} 52814 22`],
          ["SSH_CONNECTION", `${clientAddress(host)} 52814 ${host.address} 22`],
          ["SSH_TTY", "/dev/pts/0"],
        ] as [string, string][])),
    ["PATH", path],
    ["_", "/usr/bin/env"],
  ];
}

function env(ctx: SimContext, args: string[]): SimResult {
  if (args.length) throw new NotSimulated("env with a command or options");
  return ok(lines(environment(ctx).map(([k, v]) => `${k}=${v}`)));
}

function printenv(ctx: SimContext, args: string[]): SimResult {
  const vars = environment(ctx).map(([k, v]): [string, string] => [k, k === "_" ? "/usr/bin/printenv" : v]);
  const names = args.filter((a) => !a.startsWith("-"));
  if (!names.length) return ok(lines(vars.map(([k, v]) => `${k}=${v}`)));
  const found = names.map((n) => vars.find(([k]) => k === n)?.[1]);
  return { out: lines(found.filter((v): v is string => v !== undefined)), err: "", code: found.includes(undefined) ? 1 : 0 };
}

function ulimit(_ctx: SimContext, args: string[]): SimResult {
  const { flags, rest } = parseArgs(args);
  if (rest.length) return ok();
  if (flags.has("a")) {
    return ok(
      lines([
        "real-time non-blocking time  (microseconds, -R) unlimited",
        "core file size              (blocks, -c) 0",
        "data seg size               (kbytes, -d) unlimited",
        "file size                   (blocks, -f) unlimited",
        "max locked memory           (kbytes, -l) 65536",
        "open files                          (-n) 1024",
        "stack size                  (kbytes, -s) 8192",
        "cpu time                   (seconds, -t) unlimited",
        "max user processes                  (-u) 63432",
        "virtual memory              (kbytes, -v) unlimited",
      ]),
    );
  }
  if (flags.has("n")) return ok("1024\n");
  if (flags.has("u")) return ok("63432\n");
  if (flags.has("s")) return ok("8192\n");
  if (flags.has("c")) return ok("0\n");
  return ok("unlimited\n");
}

function history(ctx: SimContext, args: string[]): SimResult {
  const { flags, rest } = parseArgs(args);
  if (flags.has("c") || flags.has("w")) return ok();
  // The line that asks is the last one a real shell shows; it is not written down yet when this runs.
  const all = [...ctx.shell.history.map((h) => h.line), ["history", ...args].join(" ")];
  const count = rest.length && /^\d+$/.test(rest[0]) ? Number(rest[0]) : all.length;
  const first = Math.max(0, all.length - count);
  return ok(lines(all.slice(first).map((line, i) => `${String(first + i + 1).padStart(5)}  ${line}`)));
}

// ---- ps, kill, top -----------------------------------------------------------

interface PsField {
  head: string;
  width: number;
  right: boolean;
  value: (host: SimHost, p: Proc) => string;
}
const PS_FIELDS: Record<string, PsField> = {
  pid: { head: "PID", width: 7, right: true, value: (_h, p) => String(p.pid) },
  ppid: { head: "PPID", width: 7, right: true, value: (_h, p) => String(p.ppid) },
  user: { head: "USER", width: 8, right: false, value: (_h, p) => p.user },
  uid: { head: "UID", width: 8, right: false, value: (_h, p) => p.user },
  comm: { head: "COMMAND", width: 15, right: false, value: (_h, p) => p.comm },
  cmd: { head: "CMD", width: 27, right: false, value: (_h, p) => p.command },
  args: { head: "COMMAND", width: 27, right: false, value: (_h, p) => p.command },
  command: { head: "COMMAND", width: 27, right: false, value: (_h, p) => p.command },
  "%cpu": { head: "%CPU", width: 4, right: true, value: (_h, p) => p.cpu.toFixed(1) },
  "%mem": { head: "%MEM", width: 4, right: true, value: (_h, p) => p.mem.toFixed(1) },
  rss: { head: "RSS", width: 5, right: true, value: (h, p) => String(rssKb(h, p)) },
  vsz: { head: "VSZ", width: 6, right: true, value: (h, p) => String(vszKb(h, p)) },
  stat: { head: "STAT", width: 4, right: false, value: (_h, p) => p.stat },
  s: { head: "S", width: 1, right: false, value: (_h, p) => p.stat[0] },
  tty: { head: "TT", width: 8, right: false, value: (_h, p) => p.tty },
  time: { head: "TIME", width: 8, right: true, value: (h, p) => longCpuTime(cpuSeconds(h, p)) },
  etime: {
    head: "ELAPSED", width: 11, right: true,
    value: (h, p) => {
      const s = Math.max(0, Math.floor((h.now() - p.since) / 1000));
      const days = Math.floor(s / 86_400);
      return `${days ? `${days}-` : ""}${longCpuTime(s % 86_400)}`;
    },
  },
  etimes: { head: "ELAPSED", width: 7, right: true, value: (h, p) => String(Math.max(0, Math.floor((h.now() - p.since) / 1000))) },
  start: { head: "STARTED", width: 8, right: true, value: (h, p) => startColumn(h, p.since) },
  lstart: { head: "STARTED", width: 24, right: false, value: (_h, p) => strftime(p.since, "%a %b %e %H:%M:%S %Y") },
};
const PS_ALIASES: Record<string, string> = { pcpu: "%cpu", pmem: "%mem", tt: "tty", tname: "tty", state: "s", stime: "start", euser: "user", ucmd: "comm", ucomm: "comm", rsz: "rss", vsize: "vsz", cputime: "time" };
const psField = (name: string): PsField | undefined => PS_FIELDS[PS_ALIASES[name] ?? name];

const numbers = (text: string): number[] => text.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));

function ps(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  let everyone = false;
  let style: "plain" | "aux" | "ef" = "plain";
  let fields: string[] | undefined;
  let pids: number[] | undefined;
  let user: string | undefined;
  let comm: string | undefined;
  let sort: string | undefined;
  let noHeader = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=");
      const value = (): string => inline ?? args[++i] ?? "";
      if (key === "no-headers" || key === "no-heading" || key === "noheader") noHeader = true;
      else if (key === "sort") sort = value();
      else if (key === "pid") pids = numbers(value());
      else if (key === "user" || key === "User") user = value();
      else if (key === "format") fields = [...(fields ?? []), ...value().split(",")];
      else if (key === "forest" || key === "cols" || key === "columns" || key === "width") {
        if (key !== "forest") value();
      } else throw new NotSimulated(`ps ${a}`);
      continue;
    }
    if (/^\d[\d,]*$/.test(a)) {
      pids = [...(pids ?? []), ...numbers(a)];
      continue;
    }
    const bsd = !a.startsWith("-") || /^-[axwf]*u[axwf]*$/.test(a);
    const letters = a.replace(/^-/, "");
    for (let j = 0; j < letters.length; j++) {
      const c = letters[j];
      const value = (): string => letters.slice(j + 1) || args[++i] || "";
      if (c === "o" || (c === "O" && !bsd)) {
        fields = [...(fields ?? []), ...value().split(",")];
        break;
      }
      if (c === "p" || c === "q") {
        pids = [...(pids ?? []), ...numbers(value())];
        break;
      }
      if (c === "C" && !bsd) {
        comm = value();
        break;
      }
      if ((c === "u" || c === "U") && !bsd) {
        user = value();
        break;
      }
      if (c === "k") {
        sort = value();
        break;
      }
      if (bsd) {
        if (c === "a" || c === "x") everyone = true;
        else if (c === "u") style = "aux";
        else if (c === "e" || c === "w" || c === "f" || c === "h") noHeader ||= c === "h";
        else throw new NotSimulated(`ps ${a}`);
      } else if (c === "e" || c === "A" || c === "a" || c === "x") everyone = true;
      else if (c === "f" || c === "F") style = "ef";
      else if (c === "w" || c === "H" || c === "l" || c === "L" || c === "T") continue;
      else throw new NotSimulated(`ps ${a}`);
    }
  }

  const self: Proc = {
    pid: 3000 + ctx.shell.history.length, ppid: 1500, user: ctx.user, cpu: 0, mem: 0, command: ["ps", ...args].join(" "), comm: "ps",
    since: host.now(), tty: "pts/0", stat: "R+",
  };
  let list = [...processes(host), self];
  if (pids) list = list.filter((p) => pids.includes(p.pid));
  else if (user !== undefined) list = list.filter((p) => p.user === user);
  else if (comm !== undefined) list = list.filter((p) => comm.split(",").includes(p.comm));
  else if (!everyone) list = list.filter((p) => p.tty === "pts/0");
  if (sort) {
    for (const key of sort.split(",").reverse()) {
      const down = key.startsWith("-");
      const name = key.replace(/^[+-]/, "");
      const field = psField(name);
      if (!field) return fail(`ps: unknown sort specifier\n`, 1);
      const num = (p: Proc): number => Number(field.value(host, p));
      list.sort((a, b) => {
        const d = Number.isNaN(num(a)) ? field.value(host, a).localeCompare(field.value(host, b)) : num(a) - num(b);
        return down ? -d : d;
      });
    }
  }

  let out: string[];
  if (fields) {
    const chosen: { field: PsField; head: string }[] = [];
    for (const raw of fields.filter(Boolean)) {
      const [name, head] = raw.split("=");
      const field = psField(name.toLowerCase());
      if (!field) return fail(`error: unknown user-defined format specifier "${name}"\n\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n`, 1);
      chosen.push({ field, head: raw.includes("=") ? (head ?? "") : field.head });
    }
    const row = (cells: string[]): string =>
      chosen
        .map(({ field }, i) => (i === chosen.length - 1 && !field.right ? cells[i] : field.right ? cells[i].padStart(field.width) : cells[i].padEnd(field.width)))
        .join(" ")
        .trimEnd();
    out = list.map((p) => row(chosen.map(({ field }) => field.value(host, p))));
    if (!noHeader && chosen.some((c) => c.head)) out.unshift(row(chosen.map((c) => c.head)));
  } else if (style === "aux") {
    out = list.map((p) =>
      [
        p.user.padEnd(8), String(p.pid).padStart(7), p.cpu.toFixed(1).padStart(4), p.mem.toFixed(1).padStart(4), String(vszKb(host, p)).padStart(6),
        String(rssKb(host, p)).padStart(5), p.tty.padEnd(8), p.stat.padEnd(4), startColumn(host, p.since).padEnd(5), shortCpuTime(cpuSeconds(host, p)).padStart(6), p.command,
      ].join(" "),
    );
    if (!noHeader) out.unshift("USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND");
  } else if (style === "ef") {
    out = list.map((p) =>
      [
        p.user.padEnd(8), String(p.pid).padStart(7), String(p.ppid).padStart(7), String(Math.round(p.cpu)).padStart(2), startColumn(host, p.since).padEnd(5),
        p.tty.padEnd(8), longCpuTime(cpuSeconds(host, p)), p.command,
      ].join(" "),
    );
    if (!noHeader) out.unshift("UID          PID    PPID  C STIME TTY          TIME CMD");
  } else {
    out = list.map((p) => `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${longCpuTime(cpuSeconds(host, p))} ${p.comm}`);
    if (!noHeader) out.unshift("    PID TTY          TIME CMD");
  }
  return { out: lines(out), err: "", code: list.length ? 0 : 1 };
}

const SIGNALS = ["HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"];
/** The signals a process lives through, as far as this simulation goes. */
const HARMLESS = new Set(["0", "USR1", "USR2", "CONT", "WINCH", "CHLD", "URG", "HUP"]);

const signalName = (text: string): string | undefined => {
  const t = text.toUpperCase().replace(/^SIG/, "");
  if (t === "0") return "0";
  if (/^\d+$/.test(t)) return SIGNALS[Number(t) - 1];
  return SIGNALS.includes(t) ? t : undefined;
};

/** Sends a signal to a process: says "eperm" when this user may not, and changes the host when the process ends. */
function signal(ctx: SimContext, proc: Proc, sig: string): "eperm" | undefined {
  const { host } = ctx;
  if (!ctx.root && proc.user !== ctx.user) return "eperm";
  if (sig === "0") return undefined;
  if (proc.service) {
    if (sig === "HUP") host.reload(proc.service.name);
    else if (!HARMLESS.has(sig)) {
      host.log("systemd", `${proc.service.name}.service: Main process exited, code=killed, status=${SIGNALS.indexOf(sig) + 1}/${sig}`, 5);
      host.stop(proc.service.name);
    }
    return undefined;
  }
  if (proc.extra && !HARMLESS.has(sig)) host.processes = host.processes.filter((p) => p.pid !== proc.pid);
  // The fixed system processes take the signal and stay: there is nothing behind them to stop.
  return undefined;
}

function kill(ctx: SimContext, args: string[]): SimResult {
  let sig = "TERM";
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-l" || a === "-L") {
      if (args[i + 1] && /^\d+$/.test(args[i + 1])) return ok(`${SIGNALS[Number(args[i + 1]) - 1] ?? ""}\n`);
      return ok(lines(SIGNALS.map((s, n) => `${String(n + 1).padStart(2)}) SIG${s}`)));
    }
    if (a === "--") continue;
    if ((a === "-s" || a === "-n") && i + 1 < args.length) {
      const named = signalName(args[++i]);
      if (!named) return fail(`bash: kill: ${args[i]}: invalid signal specification\n`, 1);
      sig = named;
    } else if (a.startsWith("-") && !targets.length && a.length > 1) {
      const named = signalName(a.slice(1));
      if (!named) return fail(`bash: kill: ${a.slice(1)}: invalid signal specification\n`, 1);
      sig = named;
    } else targets.push(a);
  }
  if (!targets.length) return fail("kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n", 2);
  const errors: string[] = [];
  for (const target of targets) {
    if (!/^-?\d+$/.test(target)) {
      errors.push(`bash: kill: ${target}: arguments must be process or job IDs`);
      continue;
    }
    const proc = processes(ctx.host).find((p) => p.pid === Math.abs(Number(target)));
    if (!proc) errors.push(`bash: kill: (${target}) - No such process`);
    else if (signal(ctx, proc, sig)) errors.push(`bash: kill: (${target}) - Operation not permitted`);
  }
  return { out: "", err: lines(errors), code: errors.length ? 1 : 0 };
}

/** The processes a pattern means, as pgrep and pkill choose them. */
function matchProcesses(ctx: SimContext, flags: Set<string>, values: Map<string, string>, pattern: string): Proc[] | string {
  let test: RegExp;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern is what the person asked to match process names with, as pgrep takes it
    test = new RegExp(flags.has("x") ? `^(?:${pattern})$` : pattern, flags.has("i") ? "i" : "");
  } catch {
    return `invalid regular expression: ${pattern}`;
  }
  const user = values.get("u") ?? values.get("U");
  return processes(ctx.host).filter((p) => !p.command.startsWith("[") && (!user || user.split(",").includes(p.user)) && test.test(flags.has("f") ? p.command : p.comm));
}

function pgrep(ctx: SimContext, args: string[]): SimResult {
  const { flags, values, rest } = parseArgs(args, ["u", "U", "P", "d", "t"]);
  if (rest.length !== 1 && !(rest.length === 0 && (values.has("u") || values.has("U")))) return fail("pgrep: no matching criteria specified\nTry `pgrep --help' for more information.\n", 2);
  const found = matchProcesses(ctx, flags, values, rest[0] ?? "");
  if (typeof found === "string") return fail(`pgrep: ${found}\n`, 2);
  if (flags.has("c")) return { out: `${found.length}\n`, err: "", code: found.length ? 0 : 1 };
  const shown = found.map((p) => (flags.has("a") ? `${p.pid} ${p.command}` : flags.has("l") ? `${p.pid} ${p.comm}` : String(p.pid)));
  return { out: values.has("d") ? (shown.length ? `${shown.join(values.get("d"))}\n` : "") : lines(shown), err: "", code: found.length ? 0 : 1 };
}

function pidof(ctx: SimContext, args: string[]): SimResult {
  const names = args.filter((a) => !a.startsWith("-"));
  const found = processes(ctx.host).filter((p) => names.includes(p.comm)).map((p) => p.pid).reverse();
  return found.length ? ok(`${found.join(" ")}\n`) : fail("", 1);
}

/** The signal in front of the names: `-9`, `-KILL`, `-s KILL`, `--signal KILL`. What is left are the other arguments. */
function takeSignal(args: string[]): { sig: string | undefined; rest: string[] } {
  let sig: string | undefined = "TERM";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-s" || a === "--signal") && i + 1 < args.length) sig = signalName(args[++i]);
    else if (a.startsWith("--signal=")) sig = signalName(a.slice(9));
    else if (/^-(\d+|[A-Z][A-Z0-9]+)$/.test(a)) sig = signalName(a.slice(1));
    else rest.push(a);
  }
  return { sig, rest };
}

function pkill(ctx: SimContext, args: string[]): SimResult {
  const taken = takeSignal(args);
  if (!taken.sig) return fail("pkill: invalid signal\n", 2);
  const { flags, values, rest } = parseArgs(taken.rest, ["u", "U", "P", "t"]);
  if (rest.length !== 1 && !(rest.length === 0 && (values.has("u") || values.has("U")))) return fail("pkill: no matching criteria specified\nTry `pkill --help' for more information.\n", 2);
  const found = matchProcesses(ctx, flags, values, rest[0] ?? "");
  if (typeof found === "string") return fail(`pkill: ${found}\n`, 2);
  const errors: string[] = [];
  for (const proc of found) if (signal(ctx, proc, taken.sig)) errors.push(`pkill: killing pid ${proc.pid} failed: Operation not permitted`);
  return { out: "", err: lines(errors), code: found.length && !errors.length ? 0 : 1 };
}

function killall(ctx: SimContext, args: string[]): SimResult {
  const taken = takeSignal(args);
  if (!taken.sig) return fail("killall: unknown signal\n", 1);
  const { rest } = parseArgs(taken.rest, ["u"]);
  if (!rest.length) return fail("Usage: killall [OPTION]... [--] NAME...\n", 1);
  const errors: string[] = [];
  for (const name of rest) {
    const found = processes(ctx.host).filter((p) => p.comm === name);
    let sent = 0;
    for (const proc of found) {
      if (signal(ctx, proc, taken.sig)) errors.push(`${name}(${proc.pid}): Operation not permitted`);
      else sent++;
    }
    if (!sent) errors.push(`${name}: no process found`);
  }
  return { out: "", err: lines(errors), code: errors.length ? 1 : 0 };
}

function top(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { values } = parseArgs(args, ["n", "d", "p", "u", "o", "w"]);
  let list = processes(host);
  if (values.has("p")) list = list.filter((p) => numbers(values.get("p") ?? "").includes(p.pid));
  if (values.has("u")) list = list.filter((p) => p.user === values.get("u"));
  const byMem = /mem/i.test(values.get("o") ?? "");
  list.sort((a, b) => (byMem ? b.mem - a.mem || b.cpu - a.cpu : b.cpu - a.cpu || b.mem - a.mem) || a.pid - b.pid);
  const all = processes(host);
  const running = all.filter((p) => p.stat.startsWith("R")).length + 1;
  const busy = Math.min(99, all.reduce((sum, p) => sum + p.cpu, 0) / host.cpus);
  const m = memory(host);
  const mib = (kb: number): string => (kb / 1024).toFixed(1).padStart(9);
  const count = (n: number): string => String(n).padStart(3);
  const share = (n: number): string => n.toFixed(1).padStart(4);
  const user = busy * 0.75;
  const system = busy * 0.25;
  const head = [
    `top -${uptimeLine(host)}`,
    `Tasks: ${count(all.length + 1)} total, ${count(running)} running, ${count(all.length + 1 - running)} sleeping, ${count(0)} stopped, ${count(0)} zombie`,
    `%Cpu(s): ${share(user)} us, ${share(system)} sy, ${share(0)} ni, ${share(100 - user - system)} id, ${share(0)} wa, ${share(0)} hi, ${share(0)} si, ${share(0)} st`,
    `MiB Mem : ${mib(m.total)} total, ${mib(m.free)} free, ${mib(m.used)} used, ${mib(m.cache)} buff/cache`,
    `MiB Swap: ${mib(m.swap)} total, ${mib(m.swap)} free, ${mib(0)} used. ${mib(m.available)} avail Mem`,
    "",
    "    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
  ];
  const rows = list.map((p) => {
    const seconds = cpuSeconds(host, p);
    const res = rssKb(host, p);
    return [
      String(p.pid).padStart(7), p.user.slice(0, 8).padEnd(8), "20".padStart(3), "0".padStart(3), String(vszKb(host, p)).padStart(7), String(res).padStart(6),
      String(Math.round(res * 0.6)).padStart(6), p.stat[0], p.cpu.toFixed(1).padStart(5), p.mem.toFixed(1).padStart(5), `${Math.floor(seconds / 60)}:${p2(seconds % 60)}.00`.padStart(9), p.comm,
    ].join(" ");
  });
  return ok(lines([...head, ...rows]));
}

// ---- the network, as far as what listens -------------------------------------

const PORT_NAMES: Record<number, string> = { 21: "ftp", 22: "ssh", 25: "smtp", 53: "domain", 80: "http", 110: "pop3", 123: "ntp", 143: "imap2", 443: "https", 3306: "mysql", 5432: "postgresql" };
type Listener = ReturnType<SimHost["listening"]>[number];
const backlog = (l: Listener): number => (l.proto === "udp" ? 0 : [128, 511, 4096, 4096][hash(l.process) % 4]);
/** The file descriptor a listening socket has, the same every time. */
const fdOf = (l: Listener): number => 3 + (hash(`${l.process}:${l.port}`) % 9);
/** The program behind a port, by the name `ss -p` and `netstat -p` show: the program, which is not always the unit. */
const programOf = (host: SimHost, l: Listener): string => {
  const svc = host.service(l.process);
  return svc ? commOf(serviceCommand(svc)) : l.process;
};
const ownerOf = (host: SimHost, l: Listener): string => host.service(l.process)?.user ?? "root";
const maySee = (ctx: SimContext, l: Listener): boolean => ctx.root || ownerOf(ctx.host, l) === ctx.user;

/** Which sockets the letters of `ss` and `netstat` ask for. */
function socketChoice(args: string[], command: string): { tcp: boolean; udp: boolean; listening: boolean; all: boolean; numeric: boolean; procs: boolean; flags: Set<string> } {
  const { flags, rest } = parseArgs(args, ["f", "A", "o"]);
  if (rest.length) throw new NotSimulated(`${command} with a filter`);
  const tcp = flags.has("t") || flags.has("tcp");
  const udp = flags.has("u") || flags.has("udp");
  return {
    tcp: tcp || !udp,
    udp: udp || !tcp,
    listening: flags.has("l") || flags.has("listening"),
    all: flags.has("a") || flags.has("all"),
    numeric: flags.has("n") || flags.has("numeric"),
    procs: flags.has("p") || flags.has("processes") || flags.has("programs"),
    flags,
  };
}

function ss(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const want = socketChoice(args, "ss");
  if (want.flags.has("s") || want.flags.has("summary")) throw new NotSimulated("ss -s");
  const both = want.tcp && want.udp;
  // Without -l or -a ss shows the connections that are open, and none are kept here.
  const found = want.listening || want.all ? host.listening().filter((l) => (l.proto === "tcp" ? want.tcp : want.udp)) : [];
  const address = (l: Listener): string => (l.address.includes(":") ? `[${l.address}]` : l.address);
  const rows = found.map((l) => [
    ...(both ? [l.proto] : []),
    l.proto === "tcp" ? "LISTEN" : "UNCONN",
    "0",
    String(backlog(l)),
    `${address(l)}:${want.numeric ? l.port : (PORT_NAMES[l.port] ?? l.port)}`,
    `${l.address.includes(":") ? "[::]" : "0.0.0.0"}:*`,
    want.procs && maySee(ctx, l) && l.pid !== undefined ? `users:(("${programOf(host, l)}",pid=${l.pid},fd=${fdOf(l)}))` : "",
  ]);
  const head = [...(both ? ["Netid"] : []), "State", "Recv-Q", "Send-Q", "Local Address:Port", "Peer Address:Port", "Process"];
  if (want.flags.has("H") || want.flags.has("no-header")) return ok(lines(table(rows, both ? [4, 5] : [3, 4], "  ")));
  return ok(lines(table([head, ...rows], both ? [4, 5] : [3, 4], "  ")));
}

function netstat(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const want = socketChoice(args, "netstat");
  for (const f of ["r", "route", "i", "interfaces", "s", "statistics", "g"]) if (want.flags.has(f)) throw new NotSimulated(`netstat -${f}`);
  const servers = want.listening || want.all;
  const found = servers ? host.listening().filter((l) => (l.proto === "tcp" ? want.tcp : want.udp)) : [];
  const out = [`Active Internet connections (${want.all ? "servers and established" : want.listening ? "only servers" : "w/o servers"})`];
  out.push(`Proto Recv-Q Send-Q Local Address           Foreign Address         State      ${want.procs ? " PID/Program name" : ""}`.trimEnd());
  let hidden = false;
  for (const l of found) {
    const v6 = l.address.includes(":");
    const port = want.numeric ? String(l.port) : (PORT_NAMES[l.port] ?? String(l.port));
    const seen = maySee(ctx, l) && l.pid !== undefined;
    hidden ||= want.procs && !seen;
    out.push(
      [
        `${l.proto}${v6 ? "6" : ""}`.padEnd(5), "0".padStart(6), "0".padStart(6), `${v6 ? l.address : l.address}:${port}`.padEnd(23), `${v6 ? "::" : "0.0.0.0"}:*`.padEnd(23),
        (l.proto === "tcp" ? "LISTEN" : "").padEnd(11), want.procs ? (seen ? `${l.pid}/${programOf(host, l)}` : "-") : "",
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  const note = hidden ? "(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n" : "";
  return { out: lines(out), err: note, code: 0 };
}

function lsof(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  let spec: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-i") spec = args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : "";
    else if (a.startsWith("-i")) spec = a.slice(2);
    else if (a === "-n" || a === "-P" || a === "-nP" || a === "-Pn") continue;
    else if (a === "-sTCP:LISTEN") continue;
    else throw new NotSimulated(`lsof ${a}`);
  }
  if (spec === undefined) throw new NotSimulated("lsof without -i");
  const match = /^(tcp|udp|)(@[^:]*|)(:\d+|)$/i.exec(spec);
  if (!match) return fail(`lsof: unacceptable port specification in: -i ${spec}\n`, 1);
  const proto = match[1].toLowerCase();
  const port = match[3] ? Number(match[3].slice(1)) : undefined;
  const found = host.listening().filter((l) => (!proto || l.proto === proto) && (port === undefined || l.port === port) && maySee(ctx, l) && l.pid !== undefined);
  if (!found.length) return fail("", 1);
  const rows = found.map((l) => {
    const v6 = l.address.includes(":");
    const where = l.address === "0.0.0.0" || l.address === "::" ? "*" : v6 ? `[${l.address}]` : l.address;
    return [
      programOf(host, l).slice(0, 9), String(l.pid), ownerOf(host, l), `${fdOf(l)}u`, v6 ? "IPv6" : "IPv4", String(10_000 + (hash(`${l.process}${l.port}`) % 80_000)), "0t0",
      l.proto.toUpperCase(), `${where}:${l.port}${l.proto === "tcp" ? " (LISTEN)" : ""}`,
    ];
  });
  return ok(lines(table([["COMMAND", "PID", "USER", "FD", "TYPE", "DEVICE", "SIZE/OFF", "NODE", "NAME"], ...rows], [1, 3, 5, 6])));
}

const macOf = (host: SimHost): string => `52:54:00:${hex(`mac${host.address}`, 6).replace(/(..)(?=.)/g, "$1:")}`;
const networkOf = (host: SimHost): { net: string; broadcast: string; gateway: string } => {
  const parts = host.address.split(".");
  const base = parts.slice(0, 3).join(".");
  return { net: `${base}.0/24`, broadcast: `${base}.255`, gateway: `${base}.1` };
};

function ip(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const options = args.filter((a) => a.startsWith("-"));
  const words = args.filter((a) => !a.startsWith("-"));
  const brief = options.some((o) => o === "-br" || o === "-brief");
  const only6 = options.includes("-6");
  const only4 = options.includes("-4");
  for (const o of options) if (!["-br", "-brief", "-4", "-6", "-c", "-color", "-o", "-s", "-d"].includes(o)) throw new NotSimulated(`ip ${o}`);
  const object = words[0] ?? "";
  const { net, broadcast, gateway } = networkOf(host);
  const mac = macOf(host);
  if ("address".startsWith(object) && object) {
    const rest = words.slice(1).filter((x) => x !== "show" && x !== "list" && x !== "dev");
    if (words[1] && !["show", "list", "dev"].includes(words[1]) && !["lo", "eth0"].includes(words[1])) {
      if (!ctx.root) return fail("RTNETLINK answers: Operation not permitted\n", 2);
      throw new NotSimulated(`ip address ${words[1]}`);
    }
    const dev = rest[0];
    if (dev && dev !== "lo" && dev !== "eth0") return fail(`Device "${dev}" does not exist.\n`, 1);
    if (brief) {
      return ok(
        lines([
          ...(dev && dev !== "lo" ? [] : [`lo               UNKNOWN        ${only6 ? "" : "127.0.0.1/8 "}${only4 ? "" : "::1/128 "}`]),
          ...(dev && dev !== "eth0" ? [] : [`eth0             UP             ${only6 ? "" : `${host.address}/24 `}${only4 ? "" : `fe80::5054:ff:fe${mac.slice(9, 11)}:${mac.slice(12).replace(":", "")}/64 `}`]),
        ]),
      );
    }
    const lo = [
      "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000",
      "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
      ...(only6 ? [] : ["    inet 127.0.0.1/8 scope host lo", "       valid_lft forever preferred_lft forever"]),
      ...(only4 ? [] : ["    inet6 ::1/128 scope host noprefixroute ", "       valid_lft forever preferred_lft forever"]),
    ];
    const eth = [
      "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000",
      `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`,
      ...(only6 ? [] : [`    inet ${host.address}/24 brd ${broadcast} scope global eth0`, "       valid_lft forever preferred_lft forever"]),
      ...(only4 ? [] : [`    inet6 fe80::5054:ff:fe${mac.slice(9, 11)}:${mac.slice(12).replace(":", "")}/64 scope link `, "       valid_lft forever preferred_lft forever"]),
    ];
    return ok(lines([...(dev && dev !== "lo" ? [] : lo), ...(dev && dev !== "eth0" ? [] : eth)]));
  }
  if ("route".startsWith(object) && object) {
    if (words[1] && !["show", "list"].includes(words[1])) {
      if (!ctx.root) return fail("RTNETLINK answers: Operation not permitted\n", 2);
      throw new NotSimulated(`ip route ${words[1]}`);
    }
    return ok(lines([`default via ${gateway} dev eth0 proto dhcp src ${host.address} metric 100`, `${net} dev eth0 proto kernel scope link src ${host.address} metric 100`]));
  }
  if ("link".startsWith(object) && object) {
    if (words[1] && !["show", "list"].includes(words[1])) {
      if (!ctx.root) return fail("RTNETLINK answers: Operation not permitted\n", 2);
      throw new NotSimulated(`ip link ${words[1]}`);
    }
    return ok(
      lines([
        "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000",
        "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
        "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000",
        `    link/ether ${mac} brd ff:ff:ff:ff:ff:ff`,
      ]),
    );
  }
  throw new NotSimulated(`ip ${object || "without an object"}`);
}

function ifconfig(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const dev = args.find((a) => !a.startsWith("-"));
  if (args.filter((a) => !a.startsWith("-")).length > 1) throw new NotSimulated("changing an interface");
  if (dev && dev !== "lo" && dev !== "eth0") return fail(`${dev}: error fetching interface information: Device not found\n`, 1);
  const { broadcast } = networkOf(host);
  const eth = [
    "eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500",
    `        inet ${host.address}  netmask 255.255.255.0  broadcast ${broadcast}`,
    `        ether ${macOf(host)}  txqueuelen 1000  (Ethernet)`,
    "        RX packets 1832044  bytes 1204558211 (1.2 GB)",
    "        RX errors 0  dropped 0  overruns 0  frame 0",
    "        TX packets 1410932  bytes 388120447 (388.1 MB)",
    "        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0",
    "",
  ];
  const lo = [
    "lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536",
    "        inet 127.0.0.1  netmask 255.0.0.0",
    "        inet6 ::1  prefixlen 128  scopeid 0x10<host>",
    "        loop  txqueuelen 1000  (Local Loopback)",
    "        RX packets 90412  bytes 8120331 (8.1 MB)",
    "        RX errors 0  dropped 0  overruns 0  frame 0",
    "        TX packets 90412  bytes 8120331 (8.1 MB)",
    "        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0",
    "",
  ];
  return ok(lines([...(dev === "lo" ? [] : eth), ...(dev === "eth0" ? [] : lo)]));
}

// ---- packages ----------------------------------------------------------------

const DESCRIPTIONS: Record<string, string> = {
  nginx: "small, powerful, scalable web/proxy server",
  apache2: "Apache HTTP Server",
  haproxy: "fast and reliable load balancing reverse proxy",
  postgresql: "object-relational SQL database (supported version)",
  "postgresql-16": "The World's Most Advanced Open Source Relational Database",
  "mysql-server": "MySQL database server (metapackage depending on the latest version)",
  "redis-server": "Persistent key-value database with network interface",
  "openssh-server": "secure shell (SSH) server, for secure access from remote machines",
  openssl: "Secure Sockets Layer toolkit - cryptographic utility",
  "ca-certificates": "Common CA certificates",
  certbot: "automatically configure HTTPS using Let's Encrypt",
  curl: "command line tool for transferring data with URL syntax",
  cron: "process scheduling daemon",
  systemd: "system and service manager",
  bash: "GNU Bourne Again SHell",
  coreutils: "GNU core utilities",
  python3: "interactive high-level object-oriented language (default python3 version)",
  "docker-ce": "Docker: the open-source application container engine",
  rsyslog: "reliable system and kernel logging daemon",
  chrony: "Versatile implementation of the Network Time Protocol",
};
const describe = (name: string): string => DESCRIPTIONS[name] ?? `${name} - runtime files`;
const packageNames = (host: SimHost): string[] => Object.keys(host.packages).sort();
const matchPackages = (host: SimHost, patterns: string[]): { found: string[]; missing: string[] } => {
  if (!patterns.length) return { found: packageNames(host), missing: [] };
  const found = new Set<string>();
  const missing: string[] = [];
  for (const pattern of patterns) {
    const test = globToRegExp(pattern.replace(/:amd64$/, ""));
    const names = packageNames(host).filter((n) => test.test(n));
    if (names.length) names.forEach((n) => found.add(n));
    else missing.push(pattern);
  }
  return { found: [...found].sort(), missing };
};

function dpkgList(host: SimHost, patterns: string[]): SimResult {
  const { found, missing } = matchPackages(host, patterns);
  const errors = missing.map((m) => `dpkg-query: no packages found matching ${m}`);
  if (!found.length) return fail(lines(errors), 1);
  const nameWidth = Math.max(14, ...found.map((n) => n.length));
  const versionWidth = Math.max(12, ...found.map((n) => host.packages[n].length));
  const out = [
    "Desired=Unknown/Install/Remove/Purge/Hold",
    "| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend",
    "|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)",
    `||/ ${"Name".padEnd(nameWidth)} ${"Version".padEnd(versionWidth)} Architecture Description`,
    `+++-${"=".repeat(nameWidth)}-${"=".repeat(versionWidth)}-============-${"=".repeat(33)}`,
    ...found.map((n) => `ii  ${n.padEnd(nameWidth)} ${host.packages[n].padEnd(versionWidth)} amd64        ${describe(n)}`),
  ];
  return { out: lines(out), err: lines(errors), code: errors.length ? 1 : 0 };
}

function dpkgStatus(host: SimHost, names: string[]): SimResult {
  const blocks: string[] = [];
  const errors: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/:amd64$/, "");
    const version = host.packages[name];
    if (version === undefined) {
      errors.push(`dpkg-query: package '${name}' is not installed and no information is available`);
      continue;
    }
    blocks.push(
      lines([
        `Package: ${name}`,
        "Status: install ok installed",
        "Priority: optional",
        "Section: misc",
        `Installed-Size: ${200 + (hash(name) % 9000)}`,
        `Maintainer: ${distributor(host)} Developers <${host.os.id}-devel-discuss@lists.${host.os.id}.com>`,
        "Architecture: amd64",
        `Version: ${version}`,
        `Description: ${describe(name)}`,
      ]),
    );
  }
  if (errors.length) errors.push("Use dpkg --info (= dpkg-deb --info) to examine archive files.");
  return { out: blocks.join("\n"), err: lines(errors), code: errors.length ? 1 : 0 };
}

function dpkgShow(host: SimHost, patterns: string[], format: string | undefined): SimResult {
  const { found, missing } = matchPackages(host, patterns);
  const errors = missing.map((m) => `dpkg-query: no packages found matching ${m}`);
  const one = (name: string): string => {
    if (format === undefined) return `${name}\t${host.packages[name]}\n`;
    // `-f='…'` reaches here with its equals sign: the short option takes what follows the letter.
    const layout = format.replace(/^=/, "");
    const fields: Record<string, string> = {
      Package: name, "binary:Package": name, Version: host.packages[name], Architecture: "amd64", Status: "install ok installed", "db:Status-Abbrev": "ii ",
      "db:Status-Status": "installed", "binary:Summary": describe(name), Description: describe(name),
    };
    return layout
      .replace(/\$\{([A-Za-z:-]+)[;\d-]*\}/g, (_all, key: string) => fields[key] ?? "")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  };
  return { out: found.map(one).join(""), err: lines(errors), code: errors.length ? 1 : 0 };
}

const NO_MIRROR = "E: This simulated host has no package mirror: packages cannot be changed here.\n";

function dpkg(ctx: SimContext, args: string[]): SimResult {
  const { flags, values, rest } = parseArgs(args, ["f", "showformat"]);
  if (flags.has("l") || flags.has("list")) return dpkgList(ctx.host, rest);
  if (flags.has("s") || flags.has("status")) return rest.length ? dpkgStatus(ctx.host, rest) : fail("dpkg-query: error: --status needs a valid package name but '' is not: package name cannot be empty\n", 2);
  if (flags.has("W") || flags.has("show")) return dpkgShow(ctx.host, rest, values.get("f") ?? values.get("showformat"));
  if (flags.has("print-architecture")) return ok("amd64\n");
  if (flags.has("version")) return ok("Debian 'dpkg' package management program version 1.22.6 (amd64).\n");
  for (const f of ["i", "install", "r", "remove", "P", "purge", "configure", "unpack"]) {
    if (!flags.has(f)) continue;
    if (!ctx.root) return fail(`dpkg: error: requested operation requires superuser privilege\n`, 2);
    return fail(NO_MIRROR, 100);
  }
  throw new NotSimulated(`dpkg ${args[0] ?? "without an action"}`);
}

function dpkgQuery(ctx: SimContext, args: string[]): SimResult {
  const { flags, values, rest } = parseArgs(args, ["f", "showformat"]);
  if (flags.has("W") || flags.has("show")) return dpkgShow(ctx.host, rest, values.get("f") ?? values.get("showformat"));
  if (flags.has("l") || flags.has("list")) return dpkgList(ctx.host, rest);
  if (flags.has("s") || flags.has("status")) return dpkgStatus(ctx.host, rest);
  throw new NotSimulated(`dpkg-query ${args[0] ?? "without an action"}`);
}

const APT_CHANGES = ["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "auto-remove", "autoclean", "clean", "reinstall", "update", "build-dep", "satisfy", "edit-sources"];

function aptPolicy(host: SimHost, names: string[]): SimResult {
  const out: string[] = [];
  const notes: string[] = [];
  const mirror = host.os.id === "debian" ? "http://deb.debian.org/debian" : `http://archive.${host.os.id}.com/${host.os.id}`;
  for (const name of names) {
    const version = host.packages[name];
    if (version === undefined) {
      notes.push(`N: Unable to locate package ${name}`);
      continue;
    }
    out.push(
      `${name}:`,
      `  Installed: ${version}`,
      `  Candidate: ${version}`,
      "  Version table:",
      ` *** ${version} 500`,
      `        500 ${mirror} ${codename(host)}/main amd64 Packages`,
      "        100 /var/lib/dpkg/status",
    );
  }
  return { out: lines(out), err: lines(notes), code: 0 };
}

function aptShow(host: SimHost, names: string[]): SimResult {
  const blocks: string[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const version = host.packages[name];
    if (version === undefined) {
      errors.push(`E: No packages found`);
      continue;
    }
    blocks.push(lines([`Package: ${name}`, `Version: ${version}`, "Priority: optional", "Section: misc", "Architecture: amd64", `Installed-Size: ${200 + (hash(name) % 9000)} kB`, "APT-Manual-Installed: yes", `Description: ${describe(name)}`]));
  }
  return { out: blocks.join("\n"), err: lines([...new Set(errors)]), code: errors.length ? 100 : 0 };
}

function apt(tool: "apt" | "apt-get"): SimCommand {
  return (ctx, args) => {
    const { host } = ctx;
    const { flags, rest } = parseArgs(args, ["o", "t", "c"]);
    const action = rest[0];
    const warning = tool === "apt" ? "\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n" : "";
    if (!action) return fail(`${tool} 2.7.14 (amd64)\nUsage: ${tool} [options] command\n`, 1);
    if (APT_CHANGES.includes(action)) {
      if (!ctx.root) {
        return action === "update"
          ? fail("E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\n", 100)
          : fail("E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n", 100);
      }
      return fail(NO_MIRROR, 100);
    }
    if (tool === "apt" && action === "list") {
      if (flags.has("upgradable") || flags.has("upgradeable")) return { out: "Listing... Done\n", err: warning, code: 0 };
      const patterns = rest.slice(1).map((p) => globToRegExp(p));
      const names = packageNames(host).filter((n) => !patterns.length || patterns.some((p) => p.test(n)));
      return { out: lines(["Listing... Done", ...names.map((n) => `${n}/${codename(host)},now ${host.packages[n]} amd64 [installed]`)]), err: warning, code: 0 };
    }
    if (tool === "apt" && action === "policy") return aptPolicy(host, rest.slice(1));
    if (tool === "apt" && action === "show") {
      const shown = aptShow(host, rest.slice(1));
      return { ...shown, err: `${warning}${shown.err}` };
    }
    throw new NotSimulated(`${tool} ${action}`);
  };
}

function aptCache(ctx: SimContext, args: string[]): SimResult {
  const { rest } = parseArgs(args);
  if (rest[0] === "policy") return aptPolicy(ctx.host, rest.slice(1));
  if (rest[0] === "show" || rest[0] === "showpkg") return aptShow(ctx.host, rest.slice(1));
  throw new NotSimulated(`apt-cache ${rest[0] ?? "without an action"}`);
}

// ---- the rest: release, cron, kernel log, names, certificates ----------------

function lsbRelease(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const { flags } = parseArgs(args);
  const all = flags.has("a") || flags.has("all");
  const short = flags.has("s") || flags.has("short");
  const rows: [string, string, string][] = [
    ["i", "Distributor ID", distributor(host)],
    ["d", "Description", host.os.pretty],
    ["r", "Release", host.os.version],
    ["c", "Codename", codename(host)],
  ];
  const long: Record<string, string> = { id: "i", description: "d", release: "r", codename: "c" };
  const asked = new Set([...flags].map((f) => long[f] ?? f));
  const picked = rows.filter(([k]) => all || asked.has(k));
  if (!picked.length) return fail("No LSB modules are available.\n", 0);
  return { out: lines(picked.map(([, label, value]) => (short ? value : `${label}:\t${value}`))), err: all ? "No LSB modules are available.\n" : "", code: 0 };
}

function crontab(ctx: SimContext, args: string[]): SimResult {
  const { flags, values } = parseArgs(args, ["u"]);
  const user = values.get("u") ?? ctx.user;
  if (values.has("u") && !ctx.root && user !== ctx.user) return fail("must be privileged to use -u\n", 1);
  if (flags.has("l")) {
    const file = ctx.host.read(`/var/spool/cron/crontabs/${user}`);
    if (!file) return fail(`no crontab for ${user}\n`, 1);
    return ok(file.content.endsWith("\n") || !file.content ? file.content : `${file.content}\n`);
  }
  throw new NotSimulated("editing a crontab");
}

function dmesg(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  if (!ctx.root) return fail("dmesg: read kernel buffer failed: Operation not permitted\n", 1);
  const { flags } = parseArgs(args, ["l", "level", "n"]);
  if (flags.has("C") || flags.has("c") || flags.has("clear")) throw new NotSimulated("clearing the kernel buffer");
  const boot: [number, string][] = [
    [0, `Linux version ${host.kernel} (buildd@lcy02-amd64-080) (x86_64-linux-gnu-gcc-13 (${distributor(host)} 13.2.0) 13.2.0, GNU ld 2.42) #${/-(\d+)-/.exec(host.kernel)?.[1] ?? "1"}-${distributor(host)} SMP PREEMPT_DYNAMIC`],
    [0, `Command line: BOOT_IMAGE=/vmlinuz-${host.kernel} root=${host.diskOf("/")?.device ?? "/dev/sda1"} ro console=tty1 console=ttyS0`],
    [0.004, "Hypervisor detected: KVM"],
    [0.212, `smpboot: Allowing ${host.cpus} CPUs, 0 hotplug CPUs`],
    [0.412, `Memory: ${Math.round(totalKb(host) * 0.97)}K/${totalKb(host)}K available`],
    [1.204, "virtio_net virtio0 eth0: renamed from ens3"],
    [2.731, `EXT4-fs (${(host.diskOf("/")?.device ?? "/dev/sda1").replace("/dev/", "")}): mounted filesystem with ordered data mode. Quota mode: none.`],
    [4.118, "systemd[1]: Detected virtualization kvm."],
    [4.118, `systemd[1]: Hostname set to <${host.name}>.`],
    [6.902, "IPv6: ADDRCONF(NETDEV_CHANGE): eth0: link becomes ready"],
  ];
  const kernel: [number, string][] = sortedJournal(host)
    .filter((l) => l.unit === "kernel")
    .map((l) => [Math.max(0, (l.at - host.bootAt) / 1000), l.text]);
  const stamp = (seconds: number): string =>
    flags.has("T") || flags.has("ctime") ? `[${strftime(host.bootAt + seconds * 1000, "%a %b %e %H:%M:%S %Y")}]` : `[${seconds.toFixed(6).padStart(12)}]`;
  return ok(lines([...boot, ...kernel].map(([at, text]) => `${stamp(at)} ${text}`)));
}

function getent(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  const [database, ...keys] = args;
  if (database === "hosts") {
    const file = host.read("/etc/hosts");
    const entries: { address: string; names: string[] }[] = file
      ? file.content
          .split("\n")
          .map((l) => l.replace(/#.*/, "").trim().split(/\s+/))
          .filter((parts) => parts.length > 1)
          .map(([address, ...names]) => ({ address, names }))
      : [{ address: "127.0.0.1", names: ["localhost"] }, { address: host.address, names: [host.name] }];
    const show = (e: { address: string; names: string[] }): string => `${e.address.padEnd(15)} ${e.names.join(" ")}`;
    if (!keys.length) return ok(lines(entries.map(show)));
    const out: string[] = [];
    let code = 0;
    for (const key of keys) {
      const hit = entries.find((e) => e.names.includes(key) || e.address === key);
      if (hit) out.push(show(hit));
      else if (/^\d+\.\d+\.\d+\.\d+$/.test(key)) out.push(`${key.padEnd(15)} ${key}`);
      else code = 2;
    }
    return { out: lines(out), err: "", code };
  }
  if (database === "passwd" || database === "group") {
    const users = [...knownUsers(host).entries()];
    const row = ([name, user]: (typeof users)[number]): string =>
      database === "group"
        ? `${name}:x:${user.groups[0][0]}:`
        : `${name}:x:${user.uid}:${user.groups[0][0]}:${name === "root" ? "root" : name === host.user ? "" : name}:${user.uid === 0 ? "/root" : user.uid >= 1000 ? `/home/${name}` : `/var/lib/${name}`}:${user.uid === 0 || user.uid >= 1000 ? "/bin/bash" : "/usr/sbin/nologin"}`;
    if (!keys.length) return ok(lines(users.map(row)));
    const hits = keys.map((k) => users.find(([name, user]) => name === k || String(user.uid) === k));
    return { out: lines(hits.filter((h): h is (typeof users)[number] => Boolean(h)).map(row)), err: "", code: hits.includes(undefined) ? 2 : 0 };
  }
  throw new NotSimulated(`getent ${database ?? "without a database"}`);
}

const certSubject = (text: string): string => (text.includes("=") ? text.replace(/\s*=\s*/g, " = ").replace(/\s*,\s*/g, ", ") : `CN = ${text}`);

function certText(cert: SimCert, path: string): string[] {
  const serial = hex(`serial${path}${cert.notAfter}`, 36).replace(/(..)(?=.)/g, "$1:");
  return [
    "Certificate:",
    "    Data:",
    "        Version: 3 (0x2)",
    "        Serial Number:",
    `            ${serial}`,
    "        Signature Algorithm: sha256WithRSAEncryption",
    `        Issuer: ${certSubject(cert.issuer)}`,
    "        Validity",
    `            Not Before: ${opensslTime(cert.notBefore)}`,
    `            Not After : ${opensslTime(cert.notAfter)}`,
    `        Subject: ${certSubject(cert.subject)}`,
    "        Subject Public Key Info:",
    "            Public Key Algorithm: rsaEncryption",
    "                Public-Key: (2048 bit)",
    "        X509v3 extensions:",
    "            X509v3 Key Usage: critical",
    "                Digital Signature, Key Encipherment",
    "            X509v3 Extended Key Usage: ",
    "                TLS Web Server Authentication, TLS Web Client Authentication",
    "            X509v3 Basic Constraints: critical",
    "                CA:FALSE",
    "            X509v3 Subject Alternative Name: ",
    `                ${cert.names.map((n) => `DNS:${n}`).join(", ")}`,
    "    Signature Algorithm: sha256WithRSAEncryption",
  ];
}

function openssl(ctx: SimContext, args: string[]): SimResult {
  const { host } = ctx;
  if (args[0] === "version") return ok("OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)\n");
  if (args[0] !== "x509") throw new NotSimulated(`openssl ${args[0] ?? "without a command"}`);
  let file: string | undefined;
  let noout = false;
  const asked: string[] = [];
  let checkend: number | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "-in") file = args[++i];
    else if (a === "-noout") noout = true;
    else if (a === "-checkend") checkend = Number(args[++i]);
    else if (a === "-ext") {
      if (args[++i] !== "subjectAltName") throw new NotSimulated(`openssl x509 -ext ${args[i]}`);
      asked.push("-san");
    } else if (["-enddate", "-startdate", "-dates", "-subject", "-issuer", "-text", "-serial"].includes(a)) asked.push(a);
    else if (a === "-inform") i++;
    else throw new NotSimulated(`openssl x509 ${a}`);
  }
  if (file === undefined) throw new NotSimulated("openssl x509 reading a certificate from a pipe");
  const path = normalizePath(file, ctx.cwd);
  const cert = host.certs.get(path);
  const stored = host.read(path);
  if (!cert && !stored) return fail(`Could not open file or uri for loading certificate from ${file}\nUnable to load certificate\n`, 1);
  if (stored && !ctx.shell.mayRead(path, ctx.root)) return fail(`Could not open file or uri for loading certificate from ${file}\nUnable to load certificate\n`, 1);
  if (!cert) return fail(`Could not read certificate from ${file}\nUnable to load certificate\n`, 1);
  if (checkend !== undefined && !Number.isFinite(checkend)) return fail("x509: Non-positive number \"\" for option -checkend\n", 1);
  const out: string[] = [];
  for (const a of asked) {
    if (a === "-enddate" || a === "-dates") {
      if (a === "-dates") out.push(`notBefore=${opensslTime(cert.notBefore)}`);
      out.push(`notAfter=${opensslTime(cert.notAfter)}`);
    } else if (a === "-startdate") out.push(`notBefore=${opensslTime(cert.notBefore)}`);
    else if (a === "-subject") out.push(`subject=${certSubject(cert.subject)}`);
    else if (a === "-issuer") out.push(`issuer=${certSubject(cert.issuer)}`);
    else if (a === "-serial") out.push(`serial=${hex(`serial${path}${cert.notAfter}`, 36).toUpperCase()}`);
    else if (a === "-san") out.push("X509v3 Subject Alternative Name: ", `    ${cert.names.map((n) => `DNS:${n}`).join(", ")}`);
    else if (a === "-text") out.push(...certText(cert, path));
  }
  let code = 0;
  if (checkend !== undefined) {
    const expires = cert.notAfter <= host.now() + checkend * 1000;
    out.push(expires ? "Certificate will expire" : "Certificate will not expire");
    code = expires ? 1 : 0;
  }
  if (!noout) {
    // The certificate itself is printed after what was asked: what the file holds, when the scenario keeps one.
    if (!stored) throw new NotSimulated("openssl x509 without -noout for a certificate that is not kept as a file");
    out.push(stored.content.replace(/\n$/, ""));
  }
  return { out: lines(out), err: "", code };
}

function lscpu(ctx: SimContext): SimResult {
  const { host } = ctx;
  return ok(
    lines([
      "Architecture:             x86_64",
      "  CPU op-mode(s):         32-bit, 64-bit",
      "  Address sizes:          46 bits physical, 48 bits virtual",
      "  Byte Order:             Little Endian",
      `CPU(s):                   ${host.cpus}`,
      `  On-line CPU(s) list:    ${host.cpus > 1 ? `0-${host.cpus - 1}` : "0"}`,
      "Vendor ID:                GenuineIntel",
      "  Model name:             Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz",
      "    CPU family:           6",
      "    Model:                85",
      "    Thread(s) per core:   1",
      `    Core(s) per socket:   ${host.cpus}`,
      "    Socket(s):            1",
      "    BogoMIPS:             4999.99",
      "Virtualization features:  ",
      "  Hypervisor vendor:      KVM",
      "  Virtualization type:    full",
    ]),
  );
}

const nothing: SimCommand = () => ok();
const notHere = (what: string): SimCommand => () => {
  throw new NotSimulated(what);
};

/**
 * The system and service commands, by the name they are typed with.
 *
 * `nc` and `telnet` are left out on purpose: probing the network belongs to
 * another set of commands, and a name answered here would stand in its way.
 */
export const systemCommands: Record<string, SimCommand> = {
  systemctl,
  service,
  journalctl,

  df,
  free,
  lsblk,
  mount,
  findmnt,
  uptime: (ctx, args) => {
    const { flags } = parseArgs(args);
    if (flags.has("s") || flags.has("since")) return ok(`${ymd(ctx.host.bootAt)} ${hms(ctx.host.bootAt)}\n`);
    if (flags.has("p") || flags.has("pretty")) {
      const up = Math.floor((ctx.host.now() - ctx.host.bootAt) / 1000);
      const parts = [
        ...(up >= 604_800 ? [plural(Math.floor(up / 604_800), "week")] : []),
        ...(Math.floor((up % 604_800) / 86_400) ? [plural(Math.floor((up % 604_800) / 86_400), "day")] : []),
        ...(Math.floor((up % 86_400) / 3600) ? [plural(Math.floor((up % 86_400) / 3600), "hour")] : []),
        plural(Math.floor((up % 3600) / 60), "minute"),
      ];
      return ok(`up ${parts.join(", ")}\n`);
    }
    return ok(`${uptimeLine(ctx.host)}\n`);
  },
  nproc: (ctx) => ok(`${ctx.host.cpus}\n`),
  lscpu,

  hostname,
  hostnamectl,
  uname,
  date,
  timedatectl,
  lsb_release: lsbRelease,
  whoami: (ctx) => ok(`${ctx.user}\n`),
  id,
  groups: (ctx, args) => {
    const name = args[0] ?? ctx.user;
    const user = knownUsers(ctx.host).get(name);
    if (!user) return fail(`groups: ‘${name}’: no such user\n`, 1);
    return ok(`${args[0] ? `${name} : ` : ""}${user.groups.map(([, group]) => group).join(" ")}\n`);
  },
  w,
  who,
  last,
  lastlog,

  which,
  command,
  type,
  env,
  printenv,
  export: nothing,
  unset: nothing,
  alias: (_ctx, args) => (args.length ? ok() : ok(lines(["alias l='ls -CF'", "alias la='ls -A'", "alias ll='ls -alF'", "alias ls='ls --color=auto'"]))),
  unalias: nothing,
  set: nothing,
  umask: (ctx, args) => (args.length ? ok() : ok(ctx.root ? "0022\n" : "0002\n")),
  ulimit,
  sleep: nothing,
  clear: () => ok("\u001b[H\u001b[2J\u001b[3J"),
  history,
  exit: nothing,
  logout: nothing,
  nohup: notHere("running a command in the background with nohup"),

  ps,
  pgrep,
  pidof,
  kill,
  pkill,
  killall,
  top,
  htop: top,

  ss,
  netstat,
  lsof,
  ip,
  ifconfig,

  dpkg,
  "dpkg-query": dpkgQuery,
  apt: apt("apt"),
  "apt-get": apt("apt-get"),
  "apt-cache": aptCache,
  snap: notHere("snap packages"),

  crontab,
  dmesg,
  getent,
  openssl,
};
