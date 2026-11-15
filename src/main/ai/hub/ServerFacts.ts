import crypto from "node:crypto";
import type { FactChange, FactProblem, ServerFacts } from "../../../shared/types/aiHub";

/**
 * What is read from a server, without a model: every command only looks.
 * `aiHubServerFacts.test.ts` holds each of them to the app's own classifier
 * (`analyzeCommandSafety`): a command that is not read-only there fails the
 * build. `only` names the program a section needs, so the script skips it
 * quietly where that program does not exist.
 */
export const FACT_COMMANDS: { section: string; command: string; only?: string }[] = [
  { section: "os", command: "cat /etc/os-release" },
  { section: "kernel", command: "uname -srm" },
  { section: "hostname", command: "hostname" },
  { section: "uptime", command: "cat /proc/uptime" },
  { section: "pkg-dpkg", command: "dpkg-query -W -f '${Package} ${Version}\\n'", only: "dpkg-query" },
  { section: "pkg-rpm", command: "rpm -qa --qf '%{NAME} %{VERSION}-%{RELEASE}\\n'", only: "rpm" },
  { section: "pkg-apk", command: "apk info -v", only: "apk" },
  { section: "failed", command: "systemctl list-units --type=service --state=failed --no-legend --plain --no-pager", only: "systemctl" },
  { section: "running", command: "systemctl list-units --type=service --state=running --no-legend --plain --no-pager", only: "systemctl" },
  { section: "listen-tcp", command: "ss -H -tlnp", only: "ss" },
  { section: "listen-udp", command: "ss -H -ulnp", only: "ss" },
  { section: "peers", command: "ss -H -tn state established", only: "ss" },
  { section: "disks", command: "df -PT" },
];

/** Read-only fast triage telemetry commands for on-demand incident diagnosis. */
export const TRIAGE_COMMANDS: { section: string; command: string; only?: string }[] = [
  { section: "load", command: "cat /proc/loadavg" },
  { section: "cpus", command: "nproc", only: "nproc" },
  { section: "psi-cpu", command: "cat /proc/pressure/cpu" },
  { section: "psi-mem", command: "cat /proc/pressure/memory" },
  { section: "psi-io", command: "cat /proc/pressure/io" },
  { section: "mem", command: "free -m", only: "free" },
  { section: "inodes", command: "df -Pi" },
  { section: "dmesg-oom", command: "dmesg -T", only: "dmesg" },
  { section: "journal", command: "journalctl -p warning..emerg -n 100 --no-pager -o json", only: "journalctl" },
];

/** The certificate and file sections take paths, so they are written per path. */
export const CERT_COMMAND = (path: string): string => `openssl x509 -in ${path} -noout -enddate -subject`;
export const HASH_COMMAND = (path: string): string => `sha256sum ${path}`;

/** Files whose change is worth knowing about when something breaks. Globs are expanded on the server. */
export const DEFAULT_WATCH = [
  "/etc/ssh/sshd_config",
  "/etc/sudoers",
  "/etc/hosts",
  "/etc/fstab",
  "/etc/resolv.conf",
  "/etc/crontab",
  "/etc/sysctl.conf",
  "/etc/nginx/nginx.conf",
  "/etc/nginx/conf.d/*.conf",
  "/etc/nginx/sites-enabled/*",
  "/etc/haproxy/haproxy.cfg",
  "/etc/apache2/apache2.conf",
  "/etc/httpd/conf/httpd.conf",
  "/etc/postgresql/*/main/postgresql.conf",
  "/etc/postgresql/*/main/pg_hba.conf",
  "/etc/mysql/my.cnf",
  "/etc/redis/redis.conf",
  "/etc/systemd/system/*.service",
  "/etc/docker/daemon.json",
  "/etc/kubernetes/manifests/*.yaml",
];
export const DEFAULT_CERTS = [
  "/etc/letsencrypt/live/*/cert.pem",
  "/etc/nginx/ssl/*.crt",
  "/etc/nginx/ssl/*.pem",
  "/etc/haproxy/certs/*.pem",
  "/etc/pki/tls/certs/*.crt",
  "/etc/ssl/private/*.crt",
  "/etc/kubernetes/pki/*.crt",
];

/**
 * A path a person adds to the watch list ends up in a shell script, so it may
 * only be an absolute path of plain characters and `*`: nothing that a shell
 * reads as anything but a file name.
 */
export const isWatchPath = (path: string): boolean => /^\/[A-Za-z0-9_./*@+-]{1,200}$/.test(path) && !path.includes("..");

const MARK = "@@sshs3:";

/** The whole collection as one script for `sh -s`: a marker line before each section, nothing written anywhere. */
export function buildScript(watch: string[] = [], certs: string[] = []): string {
  const files = [...DEFAULT_WATCH, ...watch.filter(isWatchPath)];
  const certFiles = [...DEFAULT_CERTS, ...certs.filter(isWatchPath)];
  const lines = ["export LC_ALL=C", `echo '${MARK}begin'`];
  for (const { section, command, only } of FACT_COMMANDS)
    lines.push(`echo '${MARK}${section}'`, only ? `command -v ${only} >/dev/null 2>&1 && ${command} 2>/dev/null` : `${command} 2>/dev/null`);
  lines.push(
    `echo '${MARK}reboot'`,
    "[ -e /var/run/reboot-required ] && echo required",
    `echo '${MARK}certs'`,
    `for f in ${certFiles.join(" ")}; do [ -r "$f" ] && echo "$f|$(${CERT_COMMAND('"$f"')} 2>/dev/null | tr '\\n' '|')"; done`,
    `echo '${MARK}files'`,
    // A file that is there but may not be read is said to be so: it must not look like a file that was removed.
    `for f in ${files.join(" ")}; do if [ -f "$f" ]; then if [ -r "$f" ]; then ${HASH_COMMAND('"$f"')} 2>/dev/null; else echo "unreadable  $f"; fi; fi; done`,
    `echo '${MARK}end'`,
    "true",
  );
  return `${lines.join("\n")}\n`;
}

/** Build a read-only fast triage telemetry script for `sh -s`. */
export function buildTriageScript(): string {
  const lines = ["export LC_ALL=C", `echo '${MARK}begin'`];
  for (const { section, command, only } of TRIAGE_COMMANDS) {
    lines.push(
      `echo '${MARK}${section}'`,
      only ? `command -v ${only} >/dev/null 2>&1 && ${command} 2>/dev/null` : `${command} 2>/dev/null`,
    );
  }
  lines.push(`echo '${MARK}end'`, "true");
  return `${lines.join("\n")}\n`;
}

/**
 * Text that came from a server ends up in front of a model and on screen. A
 * unit or process name is whatever somebody on that server chose to call it,
 * so only plain characters are kept, and not many of them.
 */
export const plain = (text: string, max = 96): string =>
  text
    .replace(/[^A-Za-z0-9 _.:/@+=,~%()[\]-]/g, "")
    .trim()
    .slice(0, max)
    .trim();

const sections = (output: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(MARK)) {
      current = [];
      out.set(line.slice(MARK.length).trim(), current);
    } else if (current && line.trim()) current.push(line);
  }
  return out;
};

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** openssl's "notAfter=Mar  4 12:00:00 2027 GMT". */
const notAfter = (text: string): number | undefined => {
  const m = /notAfter=(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(text);
  if (!m || MONTHS[m[1].toLowerCase()] === undefined) return undefined;
  return Date.UTC(Number(m[6]), MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
};

const PSEUDO_FS_RE = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|efivarfs|ramfs|nsfs|tracefs|cgroup2?|devpts|mqueue|hugetlbfs|pstore|securityfs|debugfs|configfs|fusectl|binfmt_misc|autofs)$/;

function tryParseJson(rows: string[]): unknown {
  const raw = rows.join("\n").trim();
  if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseSocketEndpoint(token: string): { address: string; port: number } | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  const colonAt = trimmed.lastIndexOf(":");
  if (colonAt < 0) return undefined;
  const portText = trimmed.slice(colonAt + 1);
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const rawAddr = trimmed.slice(0, colonAt);
  return { address: plain(rawAddr, 60), port };
}

function extractSsEndpoints(cols: string[], hasProcessTail: boolean): { local: string; peer: string } | undefined {
  if (cols.length < 4) return undefined;
  const head = cols[0]?.toLowerCase() ?? "";
  if (head === "state" || head === "netid") return undefined;

  // Trim trailing metadata columns like `users:(...)`, `timer:(...)`, `uid:...`, `ino:...`
  let endIdx = cols.length;
  for (let i = 0; i < cols.length; i++) {
    if (/^(users:|timer:|uid:|ino:|sk:|cgroup:|---)/.test(cols[i])) {
      endIdx = i;
      break;
    }
  }
  const core = cols.slice(0, endIdx);
  if (core.length >= 2) {
    // Handle `ss -tulnp` (includes Netid column at index 0) or `ss -tlnp` (State at index 0).
    const hasNetid = /^(tcp|udp|raw|icmp|u_str|u_dgr|u_seq|nl|sctp)\d?$/i.test(core[0] ?? "");
    if (hasProcessTail && hasNetid && core.length >= 6) {
      return { local: core[4], peer: core[5] };
    }
    if (hasProcessTail && core.length >= 5 && /^\d+$/.test(core[1] ?? "") && /^\d+$/.test(core[2] ?? "")) {
      return { local: core[3], peer: core[4] };
    }
    return { local: core[core.length - 2], peer: core[core.length - 1] };
  }
  return undefined;
}

function parseDiskRows(rows: string[]): ServerFacts["disks"] {
  const json = tryParseJson(rows);
  const disks: ServerFacts["disks"] = [];
  if (Array.isArray(json)) {
    for (const item of json) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const mount = typeof obj.mount === "string" ? obj.mount : typeof obj.target === "string" ? obj.target : "";
      const fs = typeof obj.fs === "string" ? obj.fs : typeof obj.source === "string" ? obj.source : "";
      const type = typeof obj.type === "string" ? obj.type : typeof obj.fstype === "string" ? obj.fstype : "unknown";
      const usedPct = Number(
        typeof obj.usedPct === "number"
          ? obj.usedPct
          : typeof obj.pcent === "string"
            ? obj.pcent.replace("%", "")
            : obj.used_pct,
      );
      const sizeKb = Number(obj.sizeKb ?? obj.size ?? 0);
      if (!mount || !fs || PSEUDO_FS_RE.test(type) || !Number.isFinite(usedPct)) continue;
      disks.push({
        mount: plain(mount, 80),
        fs: plain(fs, 60),
        type: plain(type, 16),
        sizeKb: Number.isFinite(sizeKb) && sizeKb > 0 ? Math.round(sizeKb) : 0,
        usedPct: Math.max(0, Math.min(100, usedPct)),
      });
    }
    return disks.sort((a, b) => a.mount.localeCompare(b.mount));
  }

  // Merge wrapped POSIX lines where a long filesystem name stands alone on a line.
  const logicalLines: string[] = [];
  for (const raw of rows) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^Filesystem\b/i.test(trimmed)) continue;
    if (
      logicalLines.length > 0 &&
      !/\s/.test(logicalLines[logicalLines.length - 1]) &&
      /^(?:[A-Za-z0-9_.-]+\s+\d+|\d+)\s+\d+\s+\d+\s+\d{1,3}%\s+/.test(trimmed)
    ) {
      logicalLines[logicalLines.length - 1] = `${logicalLines[logicalLines.length - 1]} ${trimmed}`;
    } else {
      logicalLines.push(trimmed);
    }
  }

  // Robust POSIX df -PT (7 cols) and df -P fallback (6 cols).
  const DF_PT_RE = /^(\S+)\s+([A-Za-z0-9._-]+)\s+(\d+)\s+\d+\s+\d+\s+(\d{1,3})%\s+(.+)$/;
  const DF_P_RE = /^(\S+)\s+(\d+)\s+\d+\s+\d+\s+(\d{1,3})%\s+(.+)$/;
  for (const line of logicalLines) {
    const pt = DF_PT_RE.exec(line);
    if (pt) {
      const [, fs, type, size, pct, mount] = pt;
      if (PSEUDO_FS_RE.test(type) || PSEUDO_FS_RE.test(fs)) continue;
      const usedPct = Number(pct);
      if (!Number.isFinite(usedPct)) continue;
      disks.push({
        mount: plain(mount, 80),
        fs: plain(fs, 60),
        type: plain(type, 16),
        sizeKb: Number(size) || 0,
        usedPct,
      });
      continue;
    }
    const p = DF_P_RE.exec(line);
    if (p) {
      const [, fs, size, pct, mount] = p;
      if (PSEUDO_FS_RE.test(fs)) continue;
      const usedPct = Number(pct);
      if (!Number.isFinite(usedPct)) continue;
      disks.push({
        mount: plain(mount, 80),
        fs: plain(fs, 60),
        type: "unknown",
        sizeKb: Number(size) || 0,
        usedPct,
      });
    }
  }
  return disks.sort((a, b) => a.mount.localeCompare(b.mount));
}

function parseJsonServerFacts(raw: Record<string, unknown>, collectedAt: number): ServerFacts {
  const facts: ServerFacts = {
    collectedAt,
    failedServices: [],
    runningServices: [],
    listening: [],
    peers: [],
    disks: [],
    certs: [],
    files: {},
  };
  if (raw.os && typeof raw.os === "object") {
    const o = raw.os as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.NAME === "string" ? o.NAME : "";
    const version = typeof o.version === "string" ? o.version : typeof o.VERSION_ID === "string" ? o.VERSION_ID : "";
    const pretty = typeof o.pretty === "string" ? o.pretty : typeof o.PRETTY_NAME === "string" ? o.PRETTY_NAME : name;
    if (name || pretty) {
      facts.os = { name: plain(name, 40), version: plain(version, 24), pretty: plain(pretty || name, 80) };
    }
  }
  if (typeof raw.kernel === "string" && raw.kernel.trim()) facts.kernel = plain(raw.kernel, 80);
  if (typeof raw.hostname === "string" && raw.hostname.trim()) facts.hostname = plain(raw.hostname, 80);
  if (typeof raw.bootAt === "number" && Number.isFinite(raw.bootAt) && raw.bootAt > 0) facts.bootAt = raw.bootAt;
  if (typeof raw.rebootRequired === "boolean") facts.rebootRequired = raw.rebootRequired;
  if (typeof raw.packageManager === "string") {
    if (raw.packageManager === "dpkg" || raw.packageManager === "rpm" || raw.packageManager === "apk") {
      facts.packageManager = raw.packageManager;
    }
  }
  if (raw.packages && typeof raw.packages === "object" && !Array.isArray(raw.packages)) {
    facts.packages = {};
    for (const [k, v] of Object.entries(raw.packages as Record<string, unknown>)) {
      if (typeof v === "string") facts.packages[plain(k, 80)] = plain(v, 60);
    }
  }
  if (Array.isArray(raw.failedServices)) {
    facts.failedServices = raw.failedServices.filter((x): x is string => typeof x === "string").map((x) => plain(x, 80)).filter(Boolean).sort();
  }
  if (Array.isArray(raw.runningServices)) {
    facts.runningServices = raw.runningServices.filter((x): x is string => typeof x === "string").map((x) => plain(x, 80)).filter(Boolean).sort();
  }
  if (Array.isArray(raw.listening)) {
    for (const entry of raw.listening) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const proto = e.proto === "udp" ? "udp" : "tcp";
      const port = Number(e.port);
      const address = typeof e.address === "string" ? e.address : "0.0.0.0";
      const process = typeof e.process === "string" ? plain(e.process, 20) : undefined;
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        facts.listening.push({ proto, address: plain(address, 60), port, ...(process ? { process } : {}) });
      }
    }
  }
  if (Array.isArray(raw.peers)) {
    facts.peers = raw.peers.filter((x): x is string => typeof x === "string").map((x) => plain(x, 60)).filter(Boolean).slice(0, 200);
  }
  if (Array.isArray(raw.disks)) {
    facts.disks = parseDiskRows([JSON.stringify(raw.disks)]);
  }
  if (Array.isArray(raw.certs)) {
    for (const cert of raw.certs) {
      if (!cert || typeof cert !== "object") continue;
      const c = cert as Record<string, unknown>;
      if (typeof c.path === "string" && typeof c.notAfter === "number" && Number.isFinite(c.notAfter)) {
        facts.certs.push({
          path: plain(c.path, 160),
          notAfter: c.notAfter,
          ...(typeof c.subject === "string" ? { subject: plain(c.subject, 120) } : {}),
        });
      }
    }
  }
  if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)) {
    for (const [k, v] of Object.entries(raw.files as Record<string, unknown>)) {
      if (typeof v === "string") facts.files[plain(k, 200)] = plain(v, 80);
    }
  }
  return hasAnyFactsData(facts) ? facts : { ...facts, unsupported: true };
}

function hasAnyFactsData(facts: ServerFacts): boolean {
  return Boolean(
    facts.os ||
      facts.kernel ||
      facts.hostname ||
      facts.bootAt ||
      facts.packages ||
      facts.failedServices.length > 0 ||
      facts.runningServices.length > 0 ||
      facts.listening.length > 0 ||
      facts.peers.length > 0 ||
      facts.disks.length > 0 ||
      facts.certs.length > 0 ||
      Object.keys(facts.files).length > 0 ||
      facts.rebootRequired,
  );
}

export type FactsProfile = "full" | "partial" | "unsupported";

/** Classify whether parsed facts are full, partial-profile fallback, or unsupported. */
export function classifyFactsProfile(facts: ServerFacts): FactsProfile {
  if (facts.unsupported) return "unsupported";
  const hasCore = Boolean(facts.os && facts.kernel);
  const hasDynamic =
    facts.disks.length > 0 ||
    facts.listening.length > 0 ||
    facts.runningServices.length > 0 ||
    facts.failedServices.length > 0;
  return hasCore && hasDynamic ? "full" : "partial";
}

/** What the script printed, as facts. Supports native JSON, section output, and partial-facts fallback. */
export function parseFacts(output: string, collectedAt: number): ServerFacts {
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseJsonServerFacts(parsed as Record<string, unknown>, collectedAt);
      }
    } catch {
      // Fall through to sectioned parser
    }
  }

  const s = sections(output);
  const facts: ServerFacts = { collectedAt, failedServices: [], runningServices: [], listening: [], peers: [], disks: [], certs: [], files: {} };
  if (!s.has("begin") || !s.has("end")) return { ...facts, unsupported: true };

  const osRows = s.get("os") ?? [];
  const osJson = tryParseJson(osRows);
  if (osJson && typeof osJson === "object" && !Array.isArray(osJson)) {
    const o = osJson as Record<string, unknown>;
    const name = typeof o.NAME === "string" ? o.NAME : typeof o.name === "string" ? o.name : typeof o.ID === "string" ? o.ID : "";
    const version = typeof o.VERSION_ID === "string" ? o.VERSION_ID : typeof o.version === "string" ? o.version : "";
    const pretty = typeof o.PRETTY_NAME === "string" ? o.PRETTY_NAME : typeof o.pretty === "string" ? o.pretty : name;
    if (name || pretty) facts.os = { name: plain(name, 40), version: plain(version, 24), pretty: plain(pretty || name, 80) };
  } else {
    const os = Object.fromEntries(
      osRows.flatMap((line) => {
        const at = line.indexOf("=");
        return at > 0 ? [[line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")]] : [];
      }),
    ) as Record<string, string>;
    if (os.NAME || os.PRETTY_NAME) {
      facts.os = { name: plain(os.NAME ?? os.ID ?? "", 40), version: plain(os.VERSION_ID ?? "", 24), pretty: plain(os.PRETTY_NAME ?? os.NAME ?? "", 80) };
    }
  }

  if (s.get("kernel")?.[0]) facts.kernel = plain(s.get("kernel")![0], 80);
  if (s.get("hostname")?.[0]) facts.hostname = plain(s.get("hostname")![0], 80);
  const up = Number((s.get("uptime")?.[0] ?? "").split(/\s+/)[0]);
  if (Number.isFinite(up) && up > 0) facts.bootAt = collectedAt - Math.floor(up) * 1000;

  for (const [section, manager] of [["pkg-dpkg", "dpkg"], ["pkg-rpm", "rpm"], ["pkg-apk", "apk"]] as const) {
    const rows = s.get(section) ?? [];
    if (!rows.length || facts.packages) continue;
    facts.packageManager = manager;
    facts.packages = {};
    for (const row of rows.slice(0, 20_000)) {
      // apk prints name-version as one word: the version starts at the last "-<digit>".
      const m = manager === "apk" ? /^(.+?)-(\d[^\s]*)$/.exec(row.trim()) : /^(\S+)\s+(\S+)/.exec(row.trim());
      if (m) facts.packages[plain(m[1], 80)] = plain(m[2], 60);
    }
  }

  const units = (rows: string[] | undefined): string[] => {
    const rowList = rows ?? [];
    const json = tryParseJson(rowList);
    if (Array.isArray(json)) {
      return json
        .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).unit ?? (item as Record<string, unknown>).name ?? "") : ""))
        .map((name) => plain(name, 80).replace(/\.service$/, ""))
        .filter(Boolean)
        .sort();
    }
    return rowList
      .filter((row) => !/^UNIT\s+LOAD\s+ACTIVE\b/i.test(row.trim()))
      .map((row) => plain(row.trim().split(/\s+/)[0] ?? "", 80).replace(/\.service$/, ""))
      .filter(Boolean)
      .sort();
  };
  facts.failedServices = units(s.get("failed"));
  facts.runningServices = units(s.get("running"));

  for (const [section, proto] of [["listen-tcp", "tcp"], ["listen-udp", "udp"]] as const) {
    const rows = s.get(section) ?? [];
    const json = tryParseJson(rows);
    if (Array.isArray(json)) {
      for (const item of json) {
        if (!item || typeof item !== "object") continue;
        const e = item as Record<string, unknown>;
        const ep = typeof e.local === "string" ? parseSocketEndpoint(e.local) : undefined;
        const port = ep?.port ?? Number(e.port);
        const address = ep?.address ?? (typeof e.address === "string" ? plain(e.address, 60) : "0.0.0.0");
        const process = typeof e.process === "string" ? plain(e.process, 20) : undefined;
        if (!Number.isInteger(port) || port <= 0) continue;
        facts.listening.push({ proto, address, port, ...(process ? { process } : {}) });
      }
      continue;
    }
    for (const row of rows) {
      const cols = row.trim().split(/\s+/);
      const endpoints = extractSsEndpoints(cols, true);
      if (!endpoints) continue;
      const parsed = parseSocketEndpoint(endpoints.local);
      if (!parsed) continue;
      const process = /users:\(\("([^"]+)"/.exec(row)?.[1];
      facts.listening.push({ proto, address: parsed.address, port: parsed.port, ...(process ? { process: plain(process, 20) } : {}) });
    }
  }
  // One entry per protocol and port: the same port on v4 and v6 is one thing to a person. The v4 address is the one kept, so two readings agree.
  const byPort = new Map<string, ServerFacts["listening"][number]>();
  for (const l of facts.listening) {
    const had = byPort.get(`${l.proto}/${l.port}`);
    if (!had || (had.address.startsWith("[") && !l.address.startsWith("["))) byPort.set(`${l.proto}/${l.port}`, l);
  }
  facts.listening = [...byPort.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));

  const listens = new Set(facts.listening.filter((l) => l.proto === "tcp").map((l) => l.port));
  const peers = new Set<string>();
  const peerRows = s.get("peers") ?? [];
  const peerJson = tryParseJson(peerRows);
  if (Array.isArray(peerJson)) {
    for (const item of peerJson) {
      if (typeof item === "string") peers.add(plain(item, 52));
      else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const localPort = Number(obj.localPort ?? 0);
        const addr = typeof obj.address === "string" ? obj.address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "") : "";
        const port = Number(obj.port);
        if (!listens.has(localPort) && addr && Number.isInteger(port) && port > 0 && !/^(127\.|::1$)/.test(addr)) {
          peers.add(`${plain(addr, 45)}:${port}`);
        }
      }
    }
  } else {
    for (const row of peerRows) {
      const cols = row.trim().split(/\s+/);
      const endpoints = extractSsEndpoints(cols, false);
      if (!endpoints) continue;
      const localEp = parseSocketEndpoint(endpoints.local);
      const peerEp = parseSocketEndpoint(endpoints.peer);
      if (!localEp || !peerEp) continue;
      const address = peerEp.address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
      // A connection from one of this server's own listening ports was made to it, not by it.
      if (listens.has(localEp.port) || /^(127\.|::1$)/.test(address)) continue;
      peers.add(`${plain(address, 45)}:${peerEp.port}`);
    }
  }
  facts.peers = [...peers].sort().slice(0, 200);

  facts.disks = parseDiskRows(s.get("disks") ?? []);

  if (s.get("reboot")?.some((l) => l.trim() === "required")) facts.rebootRequired = true;

  for (const row of s.get("certs") ?? []) {
    const [path, ...rest] = row.split("|");
    const text = rest.join("|");
    const expires = notAfter(text);
    if (!path || expires === undefined) continue;
    const subject = /subject=\s*(.+?)\|?$/.exec(text)?.[1];
    facts.certs.push({ path: plain(path, 160), notAfter: expires, ...(subject ? { subject: plain(subject, 120) } : {}) });
  }
  facts.certs.sort((a, b) => a.path.localeCompare(b.path));

  for (const row of s.get("files") ?? []) {
    const m = /^([0-9a-f]{64}|unreadable)\s+\*?(.+)$/.exec(row.trim());
    if (m) facts.files[plain(m[2], 200)] = m[1];
  }

  // Partial-facts profile: only return unsupported when markers were missing OR nothing could be parsed.
  if (!hasAnyFactsData(facts)) return { ...facts, unsupported: true };
  return facts;
}

/** A short fingerprint of what matters, to tell quickly whether anything changed between two collections. */
export function factsHash(facts: ServerFacts): string {
  const { collectedAt: _at, bootAt, peers: _peers, disks, ...rest } = facts;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...rest, boot: bootAt ? Math.round(bootAt / 300_000) : 0, disks: disks.map((d) => [d.mount, Math.floor(d.usedPct / 5)]) }))
    .digest("hex")
    .slice(0, 24);
}

const DISK_STEPS = [80, 90, 95];
const step = (pct: number): number => DISK_STEPS.filter((s) => pct >= s).length;

/**
 * What is different now, as sentences a person would say. Things that always
 * move are left out: connections, and disk use below a threshold. A file that
 * went from readable to unreadable (or back) is not a change of the file.
 */
export function diffFacts(prev: ServerFacts, next: ServerFacts): FactChange[] {
  if (prev.unsupported || next.unsupported) return [];
  const at = next.collectedAt;
  const out: FactChange[] = [];
  const say = (kind: FactChange["kind"], text: string): void => void out.push({ at, kind, text });

  if (prev.os?.pretty && next.os?.pretty && prev.os.pretty !== next.os.pretty) say("os", `OS ${prev.os.pretty} → ${next.os.pretty}`);
  if (prev.kernel && next.kernel && prev.kernel !== next.kernel) say("kernel", `Kernel ${prev.kernel} → ${next.kernel}`);
  // A boot time that moved by more than the clocks can disagree is a restart.
  if (prev.bootAt && next.bootAt && next.bootAt - prev.bootAt > 120_000) say("reboot", `Restarted at ${new Date(next.bootAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);

  if (prev.packages && next.packages && prev.packageManager === next.packageManager) {
    const rows: string[] = [];
    for (const [name, version] of Object.entries(next.packages)) {
      const was = prev.packages[name];
      if (was === undefined) rows.push(`${name} ${version} installed`);
      else if (was !== version) rows.push(`${name} ${was} → ${version}`);
    }
    for (const name of Object.keys(prev.packages)) if (next.packages[name] === undefined) rows.push(`${name} removed`);
    rows.sort();
    if (rows.length > 25) say("package", `${rows.length} packages changed, among them: ${rows.slice(0, 12).join("; ")}`);
    else for (const row of rows) say("package", `Package ${row}`);
  }

  const failedBefore = new Set(prev.failedServices);
  const failedNow = new Set(next.failedServices);
  for (const unit of next.failedServices) if (!failedBefore.has(unit)) say("service", `Service ${unit} has failed`);
  for (const unit of prev.failedServices) if (!failedNow.has(unit)) say("service", `Service ${unit} is no longer failed`);
  // Only when both collections saw running services: on a system without systemd both lists are empty.
  if (prev.runningServices.length && next.runningServices.length) {
    const ranBefore = new Set(prev.runningServices);
    const runsNow = new Set(next.runningServices);
    for (const unit of next.runningServices) if (!ranBefore.has(unit)) say("service", `Service ${unit} is now running`);
    for (const unit of prev.runningServices) if (!runsNow.has(unit) && !failedNow.has(unit)) say("service", `Service ${unit} is no longer running`);
  }

  if (prev.listening.length || next.listening.length) {
    const key = (l: ServerFacts["listening"][number]): string => `${l.proto}/${l.port}`;
    const before = new Map(prev.listening.map((l) => [key(l), l]));
    const now = new Map(next.listening.map((l) => [key(l), l]));
    for (const [k, l] of now) if (!before.has(k)) say("port", `New listening port ${k}${l.process ? ` (${l.process})` : ""}`);
    for (const [k, l] of before) if (!now.has(k)) say("port", `Port ${k}${l.process ? ` (${l.process})` : ""} is no longer listening`);
  }

  for (const [path, hash] of Object.entries(next.files)) {
    const was = prev.files[path];
    if (was === undefined) say("file", `${path} is new`);
    else if (was !== hash && was !== "unreadable" && hash !== "unreadable") say("file", `${path} changed`);
  }
  for (const path of Object.keys(prev.files)) if (next.files[path] === undefined) say("file", `${path} is gone`);

  const disksBefore = new Map(prev.disks.map((d) => [d.mount, d]));
  for (const disk of next.disks) {
    const was = disksBefore.get(disk.mount);
    if (!was) continue;
    if (step(disk.usedPct) > step(was.usedPct)) say("disk", `Disk ${disk.mount} ${was.usedPct} % → ${disk.usedPct} %`);
    else if (step(disk.usedPct) < step(was.usedPct) && step(disk.usedPct) === 0) say("disk", `Disk ${disk.mount} is back to ${disk.usedPct} %`);
  }

  const certsBefore = new Map(prev.certs.map((c) => [c.path, c]));
  for (const cert of next.certs) {
    const was = certsBefore.get(cert.path);
    if (was && was.notAfter !== cert.notAfter) say("cert", `Certificate ${cert.path} was replaced (now valid to ${new Date(cert.notAfter).toISOString().slice(0, 10)})`);
  }
  if (!prev.rebootRequired && next.rebootRequired) say("reboot", "A restart is required (updates wait for it)");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fast Triage Telemetry Helpers                                              */
/* -------------------------------------------------------------------------- */

export interface LoadAverage {
  load1: number;
  load5: number;
  load15: number;
  runnable?: number;
  totalEntities?: number;
  cpus?: number;
}

export interface PsiMetric {
  someAvg10: number;
  someAvg60: number;
  someAvg300: number;
  fullAvg10?: number;
  fullAvg60?: number;
  fullAvg300?: number;
}

export interface PsiSummary {
  cpu?: PsiMetric;
  memory?: PsiMetric;
  io?: PsiMetric;
}

export interface MemoryStats {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  availableMb: number;
  usedPct: number;
  swapTotalMb?: number;
  swapUsedMb?: number;
  swapUsedPct?: number;
}

export interface InodeUsage {
  fs: string;
  inodes: number;
  iused: number;
  ifree: number;
  iusedPct: number;
  mount: string;
}

export interface OomEvent {
  timestamp?: string;
  process?: string;
  pid?: number;
  message: string;
}

export interface LogCluster {
  id: string;
  template: string;
  tokens: string[];
  count: number;
  sample: string;
}

export interface DrainClusterOptions {
  /** Number of prefix tokens used to descend the Drain tree (default 4). */
  maxDepth?: number;
  /** Token similarity threshold in [0, 1] required to merge into an existing cluster (default 0.5). */
  simThreshold?: number;
  /** Maximum distinct child edges before generalizing a branch to `<*>` (default 8). */
  maxChildren?: number;
}

export interface JournalSummary {
  total: number;
  criticalCount: number;
  errorCount: number;
  warningCount: number;
  topUnits: { unit: string; count: number }[];
  clusters: LogCluster[];
  sampleMessages: string[];
}

export interface TriageTelemetry {
  collectedAt: number;
  load?: LoadAverage;
  psi?: PsiSummary;
  memory?: MemoryStats;
  inodes: InodeUsage[];
  oomEvents: OomEvent[];
  journal?: JournalSummary;
}

function parsePsiLines(lines: readonly string[]): PsiMetric | undefined {
  let someAvg10: number | undefined;
  let someAvg60 = 0;
  let someAvg300 = 0;
  let fullAvg10: number | undefined;
  let fullAvg60: number | undefined;
  let fullAvg300: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/.exec(trimmed);
    if (!m) continue;
    const [, kind, a10, a60, a300] = m;
    if (kind === "some") {
      someAvg10 = Number(a10);
      someAvg60 = Number(a60);
      someAvg300 = Number(a300);
    } else {
      fullAvg10 = Number(a10);
      fullAvg60 = Number(a60);
      fullAvg300 = Number(a300);
    }
  }
  if (someAvg10 === undefined || !Number.isFinite(someAvg10)) return undefined;
  return {
    someAvg10,
    someAvg60,
    someAvg300,
    ...(fullAvg10 !== undefined ? { fullAvg10, fullAvg60, fullAvg300 } : {}),
  };
}

/** Parse `/proc/loadavg`, optional CPU count, and `/proc/pressure/{cpu,memory,io}` blocks. */
export function parseLoadAndPsi(input: {
  loadavg?: string;
  cpus?: string | number;
  psiCpu?: string;
  psiMemory?: string;
  psiIo?: string;
}): { load?: LoadAverage; psi?: PsiSummary } {
  let load: LoadAverage | undefined;
  if (input.loadavg) {
    const parts = input.loadavg.trim().split(/\s+/);
    const l1 = Number(parts[0]);
    const l5 = Number(parts[1]);
    const l15 = Number(parts[2]);
    if (parts.length >= 3 && Number.isFinite(l1) && Number.isFinite(l5) && Number.isFinite(l15)) {
      const cpuCount = typeof input.cpus === "number" ? input.cpus : Number(String(input.cpus ?? "").trim());
      const entMatch = /^(\d+)\/(\d+)$/.exec(parts[3] ?? "");
      load = {
        load1: l1,
        load5: l5,
        load15: l15,
        ...(entMatch ? { runnable: Number(entMatch[1]), totalEntities: Number(entMatch[2]) } : {}),
        ...(Number.isFinite(cpuCount) && cpuCount > 0 ? { cpus: cpuCount } : {}),
      };
    }
  }

  const cpu = input.psiCpu ? parsePsiLines(input.psiCpu.split(/\r?\n/)) : undefined;
  const memory = input.psiMemory ? parsePsiLines(input.psiMemory.split(/\r?\n/)) : undefined;
  const io = input.psiIo ? parsePsiLines(input.psiIo.split(/\r?\n/)) : undefined;
  const psi = cpu || memory || io ? { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}), ...(io ? { io } : {}) } : undefined;
  return { ...(load ? { load } : {}), ...(psi ? { psi } : {}) };
}

/** Parse `free -m` (or `free -b`/`free -k` MB-normalized lines) into structured memory stats. */
export function parseFreeMemory(output: string): MemoryStats | undefined {
  let memRow: string[] | undefined;
  let swapRow: string[] | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^Mem:/i.test(trimmed)) memRow = trimmed.split(/\s+/);
    else if (/^Swap:/i.test(trimmed)) swapRow = trimmed.split(/\s+/);
  }
  if (!memRow || memRow.length < 4) return undefined;
  const totalMb = Number(memRow[1]);
  const usedMb = Number(memRow[2]);
  const freeMb = Number(memRow[3]);
  // `free -m` from procps-ng puts `available` in column 6; fall back to free+buff/cache when absent.
  const availableCol = memRow.length >= 7 ? Number(memRow[6]) : Number.NaN;
  const availableMb = Number.isFinite(availableCol) ? availableCol : Math.max(0, totalMb - usedMb);
  if (!Number.isFinite(totalMb) || totalMb <= 0 || !Number.isFinite(usedMb)) return undefined;
  const usedPct = Math.round(((totalMb - availableMb) / totalMb) * 1000) / 10;

  let swapTotalMb: number | undefined;
  let swapUsedMb: number | undefined;
  let swapUsedPct: number | undefined;
  if (swapRow && swapRow.length >= 3) {
    const st = Number(swapRow[1]);
    const su = Number(swapRow[2]);
    if (Number.isFinite(st) && st > 0 && Number.isFinite(su)) {
      swapTotalMb = st;
      swapUsedMb = su;
      swapUsedPct = Math.round((su / st) * 1000) / 10;
    }
  }

  return {
    totalMb,
    usedMb,
    freeMb: Number.isFinite(freeMb) ? freeMb : Math.max(0, totalMb - usedMb),
    availableMb,
    usedPct: Math.max(0, Math.min(100, usedPct)),
    ...(swapTotalMb !== undefined ? { swapTotalMb, swapUsedMb, swapUsedPct } : {}),
  };
}

/** Parse `df -Pi` output into inode usage records (ignoring pseudo-filesystems). */
export function parseInodes(output: string): InodeUsage[] {
  const out: InodeUsage[] = [];
  const DF_PI_RE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d{1,3})%\s+(.+)$/;
  const lines = output.split(/\r?\n/);
  const logical: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || /^Filesystem\b/i.test(trimmed)) continue;
    if (logical.length > 0 && !/\s/.test(logical[logical.length - 1]) && /^\d+\s+\d+\s+\d+\s+\d{1,3}%\s+/.test(trimmed)) {
      logical[logical.length - 1] = `${logical[logical.length - 1]} ${trimmed}`;
    } else {
      logical.push(trimmed);
    }
  }
  for (const line of logical) {
    const m = DF_PI_RE.exec(line);
    if (!m) continue;
    const [, fs, inodesStr, iusedStr, ifreeStr, pctStr, mount] = m;
    if (PSEUDO_FS_RE.test(fs)) continue;
    const inodes = Number(inodesStr);
    const iused = Number(iusedStr);
    const ifree = Number(ifreeStr);
    const iusedPct = Number(pctStr);
    if (!Number.isFinite(inodes) || !Number.isFinite(iusedPct) || inodes <= 0) continue;
    out.push({
      fs: plain(fs, 60),
      inodes,
      iused,
      ifree,
      iusedPct,
      mount: plain(mount, 80),
    });
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

/** Extract OOM-killer / out-of-memory events from `dmesg` or `dmesg -T` output. */
export function parseDmesgOom(output: string): OomEvent[] {
  const events: OomEvent[] = [];
  const OOM_LINE_RE = /(?:\bOut of memory:|\binvoked oom-killer\b|\boom_kill_process\b|Memory cgroup out of memory)/i;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !OOM_LINE_RE.test(line)) continue;
    const tsMatch = /^\[([^\]]+)\]\s*(.+)$/.exec(line);
    const timestamp = tsMatch ? plain(tsMatch[1], 48) : undefined;
    const body = tsMatch ? tsMatch[2] : line;
    const killedMatch = /Killed process\s+(\d+)\s+\(([^)]+)\)/i.exec(body);
    const invokedMatch = /^([^\s]+)\s+invoked oom-killer/i.exec(body);
    const pid = killedMatch ? Number(killedMatch[1]) : undefined;
    const process = killedMatch ? plain(killedMatch[2], 40) : invokedMatch ? plain(invokedMatch[1], 40) : undefined;
    events.push({
      ...(timestamp ? { timestamp } : {}),
      ...(process ? { process } : {}),
      ...(pid !== undefined && Number.isFinite(pid) ? { pid } : {}),
      message: plain(body, 200),
    });
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* Lightweight TypeScript Drain-Style Log Template Clusterer                  */
/* -------------------------------------------------------------------------- */

function maskLogToken(token: string): string {
  if (!token) return token;
  // Preserve `key=value` structure while wildcarding variable values.
  const eqIdx = token.indexOf("=");
  if (eqIdx > 0 && eqIdx < token.length - 1) {
    const key = token.slice(0, eqIdx);
    const val = token.slice(eqIdx + 1);
    if (/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/.test(key) && isVariableToken(val)) {
      return `${key}=<*>`;
    }
  }
  return isVariableToken(token) ? "<*>" : token;
}

function isVariableToken(token: string): boolean {
  const stripped = token.replace(/^[,([{"']+|[,\])}"';:]+$/g, "");
  if (!stripped) return false;
  // ISO timestamp or HH:MM:SS time
  if (/^\d{4}-\d{2}-\d{2}$/.test(stripped) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(stripped)) {
    return true;
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(stripped) || /^\d{2}:\d{2}:\d{2}\.\d{1,9}$/.test(stripped)) {
    return true;
  }
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped)) return true;
  // IPv4 / IPv4:port
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped) || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(stripped)) {
    return true;
  }
  // Hex literal or long hex digest
  if (/^0x[0-9a-f]+$/i.test(stripped) || /^[0-9a-f]{12,}$/i.test(stripped)) return true;
  // Plain integer / float / duration / size token
  if (/^-?\d+[.\d]*(?:ms|us|ns|s|m|h|kb|mb|gb|b|%)?$/i.test(stripped)) return true;
  return false;
}

function tokenizeLogLine(line: string): string[] {
  // Strip leading syslog/ISO timestamp prefix before clustering message body.
  const cleaned = line
    .trim()
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*\s+/, "")
    .replace(/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+/, "");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 64)
    .map(maskLogToken);
}

interface DrainNode {
  children: Map<string, DrainNode>;
  clusters: LogCluster[];
}

function makeDrainNode(): DrainNode {
  return { children: new Map(), clusters: [] };
}

function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i] && a[i] !== "<*>") matches++;
    else if (a[i] === "<*>" && b[i] === "<*>") matches += 0.5;
  }
  return matches / a.length;
}

/**
 * Cluster raw log lines into Drain-style parameterized `<*>` templates in O(N * depth).
 */
export function clusterLogLines(lines: readonly string[], options?: DrainClusterOptions): LogCluster[] {
  const maxDepth = Math.max(1, options?.maxDepth ?? 4);
  const simThreshold = options?.simThreshold ?? 0.5;
  const maxChildren = Math.max(2, options?.maxChildren ?? 8);

  const lengthRoots = new Map<number, DrainNode>();
  const allClusters: LogCluster[] = [];

  for (const raw of lines) {
    const sample = raw.trim();
    if (!sample) continue;
    const tokens = tokenizeLogLine(sample);
    if (tokens.length === 0) continue;

    let current: DrainNode | undefined = lengthRoots.get(tokens.length);
    if (!current) {
      current = makeDrainNode();
      lengthRoots.set(tokens.length, current);
    }

    const depth = Math.min(maxDepth, tokens.length);
    for (let i = 0; i < depth; i++) {
      const tok = tokens[i];
      let next: DrainNode | undefined = current.children.get(tok);
      if (!next) {
        if (tok === "<*>") {
          next = current.children.get("<*>") ?? makeDrainNode();
          current.children.set("<*>", next);
        } else if (current.children.size < maxChildren) {
          next = makeDrainNode();
          current.children.set(tok, next);
        } else {
          next = current.children.get("<*>") ?? makeDrainNode();
          current.children.set("<*>", next);
        }
      }
      current = next;
    }

    let best: LogCluster | undefined;
    let bestSim = -1;
    for (const candidate of current.clusters) {
      const sim = tokenSimilarity(candidate.tokens, tokens);
      if (sim >= simThreshold && sim > bestSim) {
        best = candidate;
        bestSim = sim;
      }
    }

    if (best) {
      for (let i = 0; i < tokens.length; i++) {
        if (best.tokens[i] !== tokens[i]) best.tokens[i] = "<*>";
      }
      best.template = best.tokens.join(" ");
      best.count += 1;
    } else {
      const id = crypto
        .createHash("sha256")
        .update(`${tokens.length}:${tokens.join(" ")}`)
        .digest("hex")
        .slice(0, 12);
      const created: LogCluster = {
        id,
        template: tokens.join(" "),
        tokens: [...tokens],
        count: 1,
        sample: plain(sample, 200),
      };
      current.clusters.push(created);
      allClusters.push(created);
    }
  }

  return allClusters.sort((a, b) => b.count - a.count || a.template.localeCompare(b.template));
}

/**
 * Summarize `journalctl -p warning..emerg -o json` (NDJSON/JSON array) or plain journal lines,
 * including priority counts, top noisy units, and Drain-clustered log templates.
 */
export function summarizeJournalWarnings(output: string): JournalSummary {
  const unitCounts = new Map<string, number>();
  const messages: string[] = [];
  let criticalCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let total = 0;

  const trimmed = output.trim();
  const parsedEntries: Array<{ priority?: number; unit?: string; message: string }> = [];

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const msg = typeof obj.MESSAGE === "string" ? obj.MESSAGE : typeof obj.message === "string" ? obj.message : "";
        if (!msg) continue;
        parsedEntries.push({
          priority: obj.PRIORITY !== undefined ? Number(obj.PRIORITY) : undefined,
          unit:
            typeof obj._SYSTEMD_UNIT === "string"
              ? obj._SYSTEMD_UNIT
              : typeof obj.SYSLOG_IDENTIFIER === "string"
                ? obj.SYSLOG_IDENTIFIER
                : undefined,
          message: msg,
        });
      }
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  if (parsedEntries.length === 0) {
    for (const raw of output.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("{")) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const msg = typeof obj.MESSAGE === "string" ? obj.MESSAGE : typeof obj.message === "string" ? obj.message : "";
          if (!msg) continue;
          parsedEntries.push({
            priority: obj.PRIORITY !== undefined ? Number(obj.PRIORITY) : undefined,
            unit:
              typeof obj._SYSTEMD_UNIT === "string"
                ? obj._SYSTEMD_UNIT
                : typeof obj.SYSLOG_IDENTIFIER === "string"
                  ? obj.SYSLOG_IDENTIFIER
                  : undefined,
            message: msg,
          });
          continue;
        } catch {
          // Treat as plain text line
        }
      }
      const inferredPriority = /\b(emerg|alert|crit|panic|fatal)\b/i.test(line)
        ? 2
        : /\b(err|error|failed|segfault)\b/i.test(line)
          ? 3
          : 4;
      parsedEntries.push({ priority: inferredPriority, message: line });
    }
  }

  for (const entry of parsedEntries) {
    total += 1;
    const p = entry.priority;
    if (p !== undefined && p <= 2) criticalCount += 1;
    else if (p === 3) errorCount += 1;
    else warningCount += 1;

    if (entry.unit) {
      const cleanUnit = plain(entry.unit, 80).replace(/\.service$/, "");
      if (cleanUnit) unitCounts.set(cleanUnit, (unitCounts.get(cleanUnit) ?? 0) + 1);
    }
    messages.push(entry.message);
  }

  const topUnits = [...unitCounts.entries()]
    .map(([unit, count]) => ({ unit, count }))
    .sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit))
    .slice(0, 10);

  return {
    total,
    criticalCount,
    errorCount,
    warningCount,
    topUnits,
    clusters: clusterLogLines(messages),
    sampleMessages: messages.slice(0, 10).map((m) => plain(m, 200)),
  };
}

/** Parse combined `buildTriageScript()` output into `TriageTelemetry`. */
export function parseTriageTelemetry(output: string, collectedAt = Date.now()): TriageTelemetry {
  const s = sections(output);
  const { load, psi } = parseLoadAndPsi({
    loadavg: s.get("load")?.join("\n"),
    cpus: s.get("cpus")?.[0],
    psiCpu: s.get("psi-cpu")?.join("\n"),
    psiMemory: s.get("psi-mem")?.join("\n"),
    psiIo: s.get("psi-io")?.join("\n"),
  });
  const memRaw = s.get("mem")?.join("\n");
  const memory = memRaw ? parseFreeMemory(memRaw) : undefined;
  const inodes = parseInodes((s.get("inodes") ?? []).join("\n"));
  const oomEvents = parseDmesgOom((s.get("dmesg-oom") ?? []).join("\n"));
  const journalRaw = (s.get("journal") ?? []).join("\n");
  const journal = journalRaw.trim() ? summarizeJournalWarnings(journalRaw) : undefined;
  return {
    collectedAt,
    ...(load ? { load } : {}),
    ...(psi ? { psi } : {}),
    ...(memory ? { memory } : {}),
    inodes,
    oomEvents,
    ...(journal ? { journal } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Disk Velocity Time-to-Full ETA & Problems                                  */
/* -------------------------------------------------------------------------- */

export interface DiskVelocityEstimate {
  mount: string;
  currentUsedPct: number;
  ratePctPerHour: number;
  hoursToFull: number;
  predictedFullAt: number;
  sampleCount: number;
}

export interface DiskVelocityOptions {
  mount?: string;
  maxHours?: number;
}

/**
 * Estimate time-to-full ETA (in hours) per mount from two snapshots or a chronological history
 * of `ServerFacts` snapshots using ordinary least squares slope over `(collectedAt, usedPct)`.
 */
export function estimateDiskTimeToFull(
  prevOrHistory: ServerFacts | readonly ServerFacts[],
  nextOrOptions?: ServerFacts | DiskVelocityOptions,
  optionsArg?: DiskVelocityOptions,
): DiskVelocityEstimate[] {
  let snapshots: ServerFacts[];
  let opts: DiskVelocityOptions | undefined;

  if (Array.isArray(prevOrHistory)) {
    snapshots = [...prevOrHistory];
    opts = nextOrOptions && !("collectedAt" in nextOrOptions) ? (nextOrOptions as DiskVelocityOptions) : optionsArg;
  } else {
    const first = prevOrHistory as ServerFacts;
    const maybeSecond = nextOrOptions && "collectedAt" in nextOrOptions ? (nextOrOptions as ServerFacts) : undefined;
    snapshots = maybeSecond ? [first, maybeSecond] : [first];
    opts = optionsArg;
  }

  const valid = snapshots
    .filter((f) => !f.unsupported && Number.isFinite(f.collectedAt))
    .sort((a, b) => a.collectedAt - b.collectedAt);
  if (valid.length < 2) return [];

  const pointsByMount = new Map<string, Array<{ tHours: number; at: number; usedPct: number }>>();
  const t0 = valid[0].collectedAt;
  for (const snap of valid) {
    const tHours = (snap.collectedAt - t0) / 3_600_000;
    for (const d of snap.disks) {
      if (opts?.mount && d.mount !== opts.mount) continue;
      const list = pointsByMount.get(d.mount) ?? [];
      list.push({ tHours, at: snap.collectedAt, usedPct: d.usedPct });
      pointsByMount.set(d.mount, list);
    }
  }

  const maxHours = opts?.maxHours ?? Number.POSITIVE_INFINITY;
  const out: DiskVelocityEstimate[] = [];
  for (const [mount, pts] of pointsByMount) {
    if (pts.length < 2) continue;
    const n = pts.length;
    let sumX = 0;
    let sumY = 0;
    for (const p of pts) {
      sumX += p.tHours;
      sumY += p.usedPct;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      const dx = p.tHours - meanX;
      num += dx * (p.usedPct - meanY);
      den += dx * dx;
    }
    if (den <= 0) continue;
    const slope = num / den; // % per hour
    const latest = pts[pts.length - 1];
    if (slope <= 0.01 || latest.usedPct >= 100) continue;
    const hoursToFull = (100 - latest.usedPct) / slope;
    if (!Number.isFinite(hoursToFull) || hoursToFull <= 0 || hoursToFull > maxHours) continue;
    out.push({
      mount,
      currentUsedPct: latest.usedPct,
      ratePctPerHour: Math.round(slope * 100) / 100,
      hoursToFull: Math.round(hoursToFull * 10) / 10,
      predictedFullAt: latest.at + Math.round(hoursToFull * 3_600_000),
      sampleCount: n,
    });
  }

  return out.sort((a, b) => a.hoursToFull - b.hoursToFull || a.mount.localeCompare(b.mount));
}

export interface ProblemsOptions {
  /** Previous facts snapshot for two-point disk fill velocity ETA calculation. */
  prev?: ServerFacts;
  /** Historical facts snapshots (oldest or any order) for multi-point velocity ETA calculation. */
  history?: readonly ServerFacts[];
  /** Optional fast triage telemetry snapshot to flag OOM, memory, inode, PSI, and journal issues. */
  triage?: TriageTelemetry;
  /** Maximum ETA window (hours) to surface predictive disk-full warnings (default 72h). */
  etaHorizonHours?: number;
}

const DAY = 24 * 60 * 60_000;

/** What needs a person's attention on this server right now. */
export function problems(facts: ServerFacts, now: number, options?: ProblemsOptions): FactProblem[] {
  if (facts.unsupported) return [];
  const out: FactProblem[] = [];
  for (const disk of facts.disks)
    if (disk.usedPct >= 90) out.push({ kind: "disk", key: `disk:${disk.mount}`, severity: disk.usedPct >= 95 ? "critical" : "warning", text: `Disk ${disk.mount} is ${disk.usedPct} % full` });
  for (const cert of facts.certs) {
    const days = Math.floor((cert.notAfter - now) / DAY);
    if (days < 0) out.push({ kind: "cert", key: `cert:${cert.path}`, severity: "critical", text: `Certificate ${cert.path} expired ${-days} day${days === -1 ? "" : "s"} ago` });
    else if (days <= 14) out.push({ kind: "cert", key: `cert:${cert.path}`, severity: days <= 3 ? "critical" : "warning", text: `Certificate ${cert.path} expires in ${days} day${days === 1 ? "" : "s"}` });
  }
  for (const unit of facts.failedServices) out.push({ kind: "service", key: `service:${unit}`, severity: "warning", text: `Service ${unit} has failed` });

  // Predictive disk velocity ETA when prior snapshots are provided.
  const history = options?.history
    ? [...options.history, facts]
    : options?.prev
      ? [options.prev, facts]
      : undefined;
  if (history && history.length >= 2) {
    const horizon = options?.etaHorizonHours ?? 72;
    const etas = estimateDiskTimeToFull(history, { maxHours: horizon });
    for (const eta of etas) {
      out.push({
        kind: "disk",
        key: `disk-eta:${eta.mount}`,
        severity: eta.hoursToFull <= 12 ? "critical" : "warning",
        text: `Disk ${eta.mount} at ${eta.currentUsedPct}% (+${eta.ratePctPerHour}%/h, full in ~${eta.hoursToFull}h)`,
      });
    }
  }

  // Optional fast triage telemetry signals.
  if (options?.triage) {
    const t = options.triage;
    if (t.memory && t.memory.usedPct >= 90) {
      out.push({
        kind: "service",
        key: "mem:usage",
        severity: t.memory.usedPct >= 95 ? "critical" : "warning",
        text: `Memory pressure high (${t.memory.usedPct}% used, ${t.memory.availableMb} MB available)`,
      });
    }
    for (const inode of t.inodes) {
      if (inode.iusedPct >= 90) {
        out.push({
          kind: "disk",
          key: `inode:${inode.mount}`,
          severity: inode.iusedPct >= 95 ? "critical" : "warning",
          text: `Inodes on ${inode.mount} are ${inode.iusedPct}% used`,
        });
      }
    }
    if (t.psi?.memory?.fullAvg10 !== undefined && t.psi.memory.fullAvg10 >= 25) {
      out.push({
        kind: "service",
        key: "psi:memory",
        severity: t.psi.memory.fullAvg10 >= 50 ? "critical" : "warning",
        text: `Memory PSI stall avg10=${t.psi.memory.fullAvg10}%`,
      });
    }
    if (t.psi?.io?.fullAvg10 !== undefined && t.psi.io.fullAvg10 >= 40) {
      out.push({
        kind: "service",
        key: "psi:io",
        severity: t.psi.io.fullAvg10 >= 70 ? "critical" : "warning",
        text: `I/O PSI stall avg10=${t.psi.io.fullAvg10}%`,
      });
    }
    if (t.oomEvents.length > 0) {
      const latest = t.oomEvents[t.oomEvents.length - 1];
      out.push({
        kind: "service",
        key: "oom:dmesg",
        severity: "critical",
        text: `Kernel OOM killer triggered (${t.oomEvents.length}x${latest.process ? `, last: ${latest.process}` : ""})`,
      });
    }
    if (t.journal) {
      if (t.journal.criticalCount > 0) {
        out.push({
          kind: "service",
          key: "journal:critical",
          severity: "critical",
          text: `${t.journal.criticalCount} critical journal log entries detected`,
        });
      } else if (t.journal.errorCount >= 20) {
        out.push({
          kind: "service",
          key: "journal:errors",
          severity: "warning",
          text: `${t.journal.errorCount} error journal entries detected`,
        });
      }
    }
  }

  return out;
}

/** The numbers shown on a server's card. */
export function factsSummary(facts: ServerFacts): { os?: string; kernel?: string; packages: number; listening: number; services: number; disks: { mount: string; usedPct: number }[]; bootAt?: number; rebootRequired?: boolean } {
  return {
    os: facts.os?.pretty,
    kernel: facts.kernel,
    packages: Object.keys(facts.packages ?? {}).length,
    listening: facts.listening.length,
    services: facts.runningServices.length,
    disks: facts.disks.map((d) => ({ mount: d.mount, usedPct: d.usedPct })).slice(0, 12),
    bootAt: facts.bootAt,
    rebootRequired: facts.rebootRequired,
  };
}
