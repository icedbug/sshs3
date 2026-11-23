import crypto from "node:crypto";
import { DEFAULT_CERTS, DEFAULT_WATCH } from "../ai/hub/ServerFacts";
import type { SimHost } from "./SimHost";
import { SimShell } from "./SimShell";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const opensslDate = (at: number): string => {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
};

/**
 * What a simulated server prints when its facts are read: the same sections,
 * in the same form, as the real script prints on a real server, so the same
 * parser and the same comparison with the last reading are used. Everything
 * is read from the server's state, so a file an agent changed, a service it
 * restarted or a disk it freed shows as a change at the next reading.
 */
export function simFactsOutput(host: SimHost, watch: string[] = []): string {
  if (host.kind !== "linux") return 'Error: "export" is not a recognized command';
  // File patterns are expanded the way the shell on that server would.
  const shell = new SimShell(host, new Map());
  shell.cwd = "/";
  const expand = (patterns: string[]): string[] => [...new Set(patterns.flatMap((p) => (/[*?[]/.test(p) ? shell.expand(p) : host.read(p) ? [p] : [])))];
  const services = [...host.services.values()];
  const now = host.now();
  return [
    "@@sshs3:begin",
    "@@sshs3:os",
    `NAME="${host.os.pretty.split(" ")[0]}"`,
    `VERSION_ID="${host.os.version}"`,
    `PRETTY_NAME="${host.os.pretty}"`,
    "@@sshs3:kernel",
    `Linux ${host.kernel} x86_64`,
    "@@sshs3:hostname",
    host.name,
    "@@sshs3:uptime",
    `${((now - host.bootAt) / 1000).toFixed(2)} 1000.00`,
    "@@sshs3:pkg-dpkg",
    ...Object.entries(host.packages).map(([name, version]) => `${name} ${version}`),
    "@@sshs3:failed",
    ...services.filter((s) => s.state === "failed").map((s) => `${s.name}.service loaded failed failed ${s.description}`),
    "@@sshs3:running",
    ...services.filter((s) => s.state === "active").map((s) => `${s.name}.service loaded active running ${s.description}`),
    "@@sshs3:listen-tcp",
    ...host
      .listening()
      .filter((l) => l.proto === "tcp")
      .map((l) => `LISTEN 0 511 ${l.address}:${l.port} 0.0.0.0:* users:(("${l.process}",pid=${l.pid ?? 0},fd=6))`),
    "@@sshs3:listen-udp",
    ...host
      .listening()
      .filter((l) => l.proto === "udp")
      .map((l) => `UNCONN 0 0 ${l.address}:${l.port} 0.0.0.0:* users:(("${l.process}",pid=${l.pid ?? 0},fd=5))`),
    "@@sshs3:peers",
    ...(host.peers ?? []).map((p) => `ESTAB 0 0 ${host.address}:${p.localPort} ${p.remoteIp}:${p.remotePort}${p.process ? ` users:(("${p.process}",pid=1000,fd=9))` : ""}`),
    "@@sshs3:disks",
    "Filesystem Type 1024-blocks Used Available Capacity Mounted on",
    ...host.disks.map((d) => {
      const use = host.diskUse(d);
      return `${d.device} ${d.fs} ${d.sizeKb} ${use.usedKb} ${use.availKb} ${use.pct}% ${d.mount}`;
    }),
    "@@sshs3:reboot",
    ...(host.read("/var/run/reboot-required") ? ["required"] : []),
    "@@sshs3:certs",
    ...expand(DEFAULT_CERTS)
      .filter((path) => host.certs.has(path))
      .map((path) => {
        const cert = host.certs.get(path)!;
        return `${path}|notAfter=${opensslDate(cert.notAfter)}|subject=${cert.subject}|`;
      }),
    "@@sshs3:files",
    ...expand([...DEFAULT_WATCH, ...watch]).map((path) => {
      const file = host.read(path)!;
      return (file.mode & 0o004) === 0 && file.owner !== "root" ? `unreadable  ${path}` : `${crypto.createHash("sha256").update(file.content).digest("hex")}  ${path}`;
    }),
    "@@sshs3:end",
  ].join("\n");
}
