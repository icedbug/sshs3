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

/** What the script printed, as facts. A system that answered nothing the script knows is `unsupported`. */
export function parseFacts(output: string, collectedAt: number): ServerFacts {
  const s = sections(output);
  const facts: ServerFacts = { collectedAt, failedServices: [], runningServices: [], listening: [], peers: [], disks: [], certs: [], files: {} };
  if (!s.has("begin") || !s.has("end") || (!s.get("kernel")?.length && !s.get("os")?.length)) return { ...facts, unsupported: true };

  const os = Object.fromEntries(
    (s.get("os") ?? []).flatMap((line) => {
      const at = line.indexOf("=");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")]] : [];
    }),
  ) as Record<string, string>;
  if (os.NAME || os.PRETTY_NAME) facts.os = { name: plain(os.NAME ?? os.ID ?? "", 40), version: plain(os.VERSION_ID ?? "", 24), pretty: plain(os.PRETTY_NAME ?? os.NAME ?? "", 80) };
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

  const units = (rows: string[] | undefined): string[] =>
    (rows ?? []).map((row) => plain(row.trim().split(/\s+/)[0] ?? "", 80).replace(/\.service$/, "")).filter(Boolean).sort();
  facts.failedServices = units(s.get("failed"));
  facts.runningServices = units(s.get("running"));

  for (const [section, proto] of [["listen-tcp", "tcp"], ["listen-udp", "udp"]] as const)
    for (const row of s.get(section) ?? []) {
      const cols = row.trim().split(/\s+/);
      // State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=…))]; udp rows have the same shape.
      const local = cols[3] ?? "";
      const at = local.lastIndexOf(":");
      const port = Number(local.slice(at + 1));
      if (at < 0 || !Number.isInteger(port) || port <= 0) continue;
      const process = /users:\(\("([^"]+)"/.exec(row)?.[1];
      facts.listening.push({ proto, address: plain(local.slice(0, at), 60), port, ...(process ? { process: plain(process, 20) } : {}) });
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
  for (const row of s.get("peers") ?? []) {
    const cols = row.trim().split(/\s+/);
    const [local, peer] = [cols[cols.length - 2] ?? "", cols[cols.length - 1] ?? ""];
    const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
    const cut = peer.lastIndexOf(":");
    const address = peer.slice(0, cut).replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
    const port = Number(peer.slice(cut + 1));
    // A connection from one of this server's own listening ports was made to it, not by it.
    if (cut < 0 || listens.has(localPort) || !Number.isInteger(port) || /^(127\.|::1$)/.test(address)) continue;
    peers.add(`${plain(address, 45)}:${port}`);
  }
  facts.peers = [...peers].sort().slice(0, 200);

  for (const row of (s.get("disks") ?? []).slice(1)) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const [fs, type, size, , , pct, ...mount] = cols;
    if (/^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|efivarfs|ramfs|nsfs|tracefs|cgroup2?)$/.test(type)) continue;
    const usedPct = Number(pct.replace("%", ""));
    if (!Number.isFinite(usedPct)) continue;
    facts.disks.push({ mount: plain(mount.join(" "), 80), fs: plain(fs, 60), type: plain(type, 16), sizeKb: Number(size) || 0, usedPct });
  }
  facts.disks.sort((a, b) => a.mount.localeCompare(b.mount));

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

const DAY = 24 * 60 * 60_000;

/** What needs a person's attention on this server right now. */
export function problems(facts: ServerFacts, now: number): FactProblem[] {
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
