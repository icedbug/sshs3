import { execFile } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PerfK8sRaw, PerfK8sResult, PerfK8sTarget, PerfSshRaw, PerfSshResult } from '../../shared/types/perf';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import { loadK8sClient } from './k8sClient';
import { loadKubeConfigForContext } from './k8sKubeConfig';
import { sshClientFileArgs } from '../web/tenantBoundary';

/** Host + mux socket of a live SSH session, resolved on the main side so the renderer never supplies them. */
export interface PerfSshSessionInfo {
  host: string;
  controlPath?: string;
  /** Full connection config, used on Windows where there is no mux socket to reuse. */
  config?: SSHConnectionConfig;
  /** The session's askpass environment (Windows password fallback only). */
  askpassEnv?: Record<string, string>;
}

/**
 * Fixed script run on the remote host through the already-open ControlMaster connection. It is a constant — no
 * user input is ever interpolated. Wrapped in `sh -c` so it behaves the same under bash/zsh/fish/csh logins, and
 * it must not contain single quotes (it is single-quoted below). On hosts without /proc (macOS/BSD) the sections
 * are missing and the parser reports "unsupported".
 */
const REMOTE_SCRIPT =
  'for f in stat loadavg meminfo net/dev uptime diskstats; do echo "@@$f"; ' +
  'if [ $f = stat ]; then grep ^cpu /proc/stat; else cat /proc/$f; fi; done; ' +
  'echo @@df; df -Pk 2>/dev/null';
const REMOTE_COMMAND = `sh -c '${REMOTE_SCRIPT}'`;

const SSH_TIMEOUT_MS = 4000;
const SSH_FALLBACK_TIMEOUT_MS = 12000;
const SSH_MAX_BUFFER = 256 * 1024;

const K8S_NAME_RE = /^[a-z0-9][-a-z0-9.]*$/;

function splitSections(stdout: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('@@')) {
      current = [];
      sections.set(line.slice(2).trim(), current);
    } else if (current && line.trim() !== '') {
      current.push(line);
    }
  }
  return sections;
}

const PHYSICAL_DISK_RE = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/** Parses the output of REMOTE_SCRIPT. Returns null when the host is not a Linux /proc system. */
export function parseProcSnapshot(stdout: string, now: number = Date.now()): PerfSshRaw | null {
  const sections = splitSections(stdout);

  const cpuLines = sections.get('stat') ?? [];
  const cpuAgg = cpuLines.find((l) => /^cpu\s/.test(l));
  const loadLine = sections.get('loadavg')?.[0];
  const memLines = sections.get('meminfo');
  if (!cpuAgg || !loadLine || !memLines) return null;

  const cpuFields = cpuAgg.trim().split(/\s+/).slice(1).map(Number);
  if (cpuFields.length < 4 || cpuFields.some((n) => !Number.isFinite(n))) return null;
  const cpuTotal = cpuFields.slice(0, 8).reduce((a, b) => a + b, 0);
  const cpuIdle = cpuFields[3] + (cpuFields[4] ?? 0);
  const perCore: Array<{ total: number; idle: number }> = [];
  for (const l of cpuLines) {
    if (!/^cpu\d+\s/.test(l)) continue;
    const f = l.trim().split(/\s+/).slice(1).map(Number);
    if (f.length < 4 || f.some((n) => !Number.isFinite(n))) continue;
    perCore.push({ total: f.slice(0, 8).reduce((a, b) => a + b, 0), idle: f[3] + (f[4] ?? 0) });
  }
  const cores = Math.max(1, perCore.length);

  const loadParts = loadLine.trim().split(/\s+/);
  const load: [number, number, number] = [num(loadParts[0]), num(loadParts[1]), num(loadParts[2])];
  if (load.some((n) => Number.isNaN(n))) return null;
  const procsMatch = /^(\d+)\/(\d+)$/.exec(loadParts[3] ?? '');

  const mem = new Map<string, number>();
  for (const l of memLines) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) mem.set(m[1], Number(m[2]));
  }
  const memTotalKb = mem.get('MemTotal');
  if (!memTotalKb) return null;
  // MemAvailable is missing on kernels < 3.14; approximate with free + buffers + cached.
  const memAvailKb =
    mem.get('MemAvailable') ?? (mem.get('MemFree') ?? 0) + (mem.get('Buffers') ?? 0) + (mem.get('Cached') ?? 0);

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const l of sections.get('net/dev') ?? []) {
    const idx = l.indexOf(':');
    if (idx < 0) continue;
    const iface = l.slice(0, idx).trim();
    if (iface === 'lo') continue;
    const f = l
      .slice(idx + 1)
      .trim()
      .split(/\s+/);
    const rx = num(f[0]);
    const tx = num(f[8]);
    if (!Number.isNaN(rx)) netRxBytes += rx;
    if (!Number.isNaN(tx)) netTxBytes += tx;
  }

  const disks: Array<{ mount: string; usedPct: number; sizeKb: number }> = [];
  for (const l of sections.get('df') ?? []) {
    // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted-on (mount may contain spaces)
    const f = l.trim().split(/\s+/);
    if (f.length < 6 || !f[0].startsWith('/') || !/^\d+%$/.test(f[4])) continue;
    disks.push({ mount: f.slice(5).join(' '), usedPct: Number(f[4].slice(0, -1)), sizeKb: num(f[1]) });
  }
  const diskUsedPct = disks.find((d) => d.mount === '/')?.usedPct;

  let diskReadBytes = 0;
  let diskWriteBytes = 0;
  let sawDisk = false;
  for (const l of sections.get('diskstats') ?? []) {
    const f = l.trim().split(/\s+/);
    if (f.length < 10 || !PHYSICAL_DISK_RE.test(f[2])) continue;
    sawDisk = true;
    diskReadBytes += num(f[5]) * 512 || 0;
    diskWriteBytes += num(f[9]) * 512 || 0;
  }

  return {
    t: now,
    cpuTotal,
    cpuIdle,
    cpuIowait: cpuFields[4] ?? 0,
    cpuSteal: cpuFields[7] ?? 0,
    perCore,
    cores,
    load,
    procsRunning: procsMatch ? Number(procsMatch[1]) : undefined,
    procsTotal: procsMatch ? Number(procsMatch[2]) : undefined,
    memTotalKb,
    memAvailKb,
    memCacheKb: (mem.get('Buffers') ?? 0) + (mem.get('Cached') ?? 0) + (mem.get('SReclaimable') ?? 0),
    swapTotalKb: mem.get('SwapTotal') ?? 0,
    swapFreeKb: mem.get('SwapFree') ?? 0,
    diskUsedPct,
    disks: disks.length ? disks : undefined,
    diskReadBytes: sawDisk ? diskReadBytes : undefined,
    diskWriteBytes: sawDisk ? diskWriteBytes : undefined,
    netRxBytes,
    netTxBytes,
    uptimeSec: num(sections.get('uptime')?.[0]?.split(/\s+/)[0]) || 0,
  };
}

/** Kubernetes CPU quantity ("123456n", "250m", "1", "0.5") -> millicores. */
export function parseCpuMillicores(q: string | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([numk]?)$/.exec(q.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  switch (m[2]) {
    case 'n':
      return v / 1_000_000;
    case 'u':
      return v / 1_000;
    case 'm':
      return v;
    case 'k':
      return v * 1_000_000;
    default:
      return v * 1000;
  }
}

/** Kubernetes memory quantity ("128Mi", "1G", "123456Ki", "5e6") -> bytes. */
export function parseMemBytes(q: string | undefined): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([A-Za-z]*[0-9]*)$/.exec(q.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  const mult: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    m: 1e-3,
  };
  if (!m[2]) return v;
  if (m[2] in mult) return v * mult[m[2]];
  const exp = /^e([0-9]+)$/.exec(m[2]);
  return exp ? v * 10 ** Number(exp[1]) : 0;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } } | undefined;
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode;
}

export function isValidPerfK8sTarget(t: unknown): t is PerfK8sTarget {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  const name = (v: unknown): boolean =>
    typeof v === 'string' && v.length <= 253 && K8S_NAME_RE.test(v) && !/[-.]$/.test(v);
  return (
    typeof o.contextName === 'string' &&
    o.contextName.length > 0 &&
    o.contextName.length <= 512 &&
    name(o.namespace) &&
    name(o.podName) &&
    name(o.containerName)
  );
}

/** The filesystem holding the user's home (root of the drive on Windows, `/` elsewhere). */
async function localDisk(): Promise<{ mount: string; usedPct: number; sizeKb: number } | undefined> {
  try {
    const root = process.platform === 'win32' ? path.parse(os.homedir()).root : '/';
    const st = await fs.promises.statfs(root);
    const used = st.blocks - st.bfree;
    const denom = used + st.bavail; // mirrors df: bavail excludes root-reserved blocks
    if (denom <= 0) return undefined;
    return { mount: root, usedPct: Math.round((100 * used) / denom), sizeKb: (st.blocks * st.bsize) / 1024 };
  } catch {
    return undefined;
  }
}

/** TCP connect time to the session's sshd, or undefined when not meaningful (proxy/jump host) or unreachable. */
function tcpConnectMs(config: SSHConnectionConfig | undefined): Promise<number | undefined> {
  if (!config || config.proxy?.enabled || config.proxyJump?.trim()) return Promise.resolve(undefined);
  // Resolve first (untimed, IPv4 preferred like ping) so DNS and IPv6->IPv4 fallback delays aren't counted.
  const lookup = (family: 4 | 0): Promise<string | undefined> =>
    dns.promises.lookup(config.host, { family }).then(
      (r) => r.address,
      () => undefined
    );
  return lookup(4)
    .then((a) => a ?? lookup(0))
    .then(
      (address) =>
        new Promise<number | undefined>((resolve) => {
          if (!address) return resolve(undefined);
          const start = process.hrtime.bigint();
          const sock = net.connect({ host: address, port: config.port ?? 22, autoSelectFamily: false });
          const done = (ms?: number): void => {
            sock.destroy();
            resolve(ms);
          };
          sock.setTimeout(3000, () => done());
          sock.once('error', () => done());
          sock.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6));
        })
    );
}

export class PerfMetricsService {
  constructor(
    private readonly getSshSession: (sessionId: string) => PerfSshSessionInfo | undefined,
    private readonly kubeConfigPath?: string
  ) {}

  async sampleSsh(sessionId: unknown): Promise<PerfSshResult> {
    if (typeof sessionId !== 'string') return { ok: false, reason: 'no-session' };
    const info = this.getSshSession(sessionId);
    if (!info) return { ok: false, reason: 'no-session' };

    const sshBinary = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
    let args: string[];
    let env: NodeJS.ProcessEnv | undefined;
    let timeout = SSH_TIMEOUT_MS;
    let viaMux = true;
    if (info.controlPath && fs.existsSync(info.controlPath)) {
      // Defense in depth against argv flag smuggling (same guard as SSHPtyManager's `-O exit`).
      if (info.host.startsWith('-') || info.controlPath.startsWith('-')) return { ok: false, reason: 'error' };
      // On a web server: the account's own ssh files, as for the connection the socket belongs to.
      let clientFiles: string[];
      try {
        clientFiles = sshClientFileArgs(info.config ?? {});
      } catch {
        return { ok: false, reason: 'error' };
      }
      args = [
        ...clientFiles,
        '-S',
        info.controlPath,
        '-T',
        '-o',
        'ControlMaster=no',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=3',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'RemoteCommand=none',
        '--',
        info.host,
        REMOTE_COMMAND,
      ];
    } else if (process.platform === 'win32' && info.config) {
      // Windows OpenSSH has no ControlMaster, so there is no socket to piggyback on. Open a short-lived,
      // non-interactive connection instead (BatchMode: key/agent auth works, a password prompt just fails).
      viaMux = false;
      timeout = SSH_FALLBACK_TIMEOUT_MS;
      const cfg = info.config;
      // Every sample is a new login, so only methods that need no per-login user interaction qualify: FIDO2 would
      // need a PIN/touch each time, a smartcard needs its private agent (else a PIN each time), and a password
      // needs to be saved.
      const needsUser =
        cfg.authType === 'fido2' ||
        (cfg.authType === 'smartcard' && !cfg.agentPath) ||
        (cfg.authType === 'password' && !cfg.password);
      if (needsUser) return { ok: false, reason: 'auth-unsupported' };
      // A saved password is answered through the session's askpass helper, which BatchMode would disable.
      const usePassword = cfg.authType === 'password';
      if (usePassword && !info.askpassEnv) return { ok: false, reason: 'auth-unsupported' };
      try {
        const base = SmartcardDetector.buildSSHArguments({
          ...info.config,
          tunnels: [],
          x11Forwarding: false,
        });
        // buildSSHArguments ends with `-- destination`, so the remote command goes last.
        args = [
          '-T',
          '-o',
          usePassword ? 'NumberOfPasswordPrompts=1' : 'BatchMode=yes',
          '-o',
          'ConnectTimeout=8',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'RemoteCommand=none',
          ...base,
          REMOTE_COMMAND,
        ];
      } catch {
        return { ok: false, reason: 'error' };
      }
      env = { ...process.env, ...SmartcardDetector.buildProxyEnv(info.config), ...(usePassword ? info.askpassEnv : {}) };
      if (info.config.agentPath) env.SSH_AUTH_SOCK = info.config.agentPath;
    } else {
      // Fail closed: without a live mux socket ssh would open a brand-new connection and could prompt for auth.
      return { ok: false, reason: 'no-session' };
    }

    const started = Date.now();
    // A fresh connection pays for the handshake, so time a bare TCP connect to the sshd port instead.
    const tcpLatency = viaMux ? Promise.resolve(undefined) : tcpConnectMs(info.config);
    const stdout = await new Promise<string | null>((resolve) => {
      execFile(sshBinary, args, { timeout, maxBuffer: SSH_MAX_BUFFER, env, windowsHide: true }, (err, out) => {
        resolve(err ? null : String(out));
      });
    });
    if (stdout === null) return { ok: false, reason: 'error' };
    const raw = parseProcSnapshot(stdout);
    if (!raw) return { ok: false, reason: 'unsupported' };
    // Includes the remote script's runtime (a few ms), which is fine for a "how laggy is this link" figure.
    raw.latencyMs = viaMux ? Date.now() - started : await tcpLatency;
    return { ok: true, raw };
  }

  /** Samples the machine the app runs on (local shell panes). Linux reuses the /proc parser; others use `os`. */
  async sampleLocal(): Promise<PerfSshResult> {
    try {
      const disk = await localDisk();
      if (process.platform === 'linux') {
        const read = (f: string): Promise<string> => fs.promises.readFile(`/proc/${f}`, 'utf8');
        const [stat, loadavg, meminfo, netDev, uptime, diskstats] = await Promise.all(
          ['stat', 'loadavg', 'meminfo', 'net/dev', 'uptime', 'diskstats'].map((f) => read(f).catch(() => ''))
        );
        const raw = parseProcSnapshot(
          `@@stat\n${stat.split('\n').filter((l) => l.startsWith('cpu')).join('\n')}\n@@loadavg\n${loadavg}\n` +
            `@@meminfo\n${meminfo}\n@@net/dev\n${netDev}\n@@uptime\n${uptime}\n@@diskstats\n${diskstats}\n`
        );
        if (!raw) return { ok: false, reason: 'unsupported' };
        if (disk) {
          raw.diskUsedPct = disk.usedPct;
          raw.disks = [disk];
        }
        return { ok: true, raw };
      }
      const cpus = os.cpus();
      const perCore = cpus.map((c) => ({
        total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
        idle: c.times.idle,
      }));
      let total = 0;
      let idle = 0;
      for (const c of cpus) {
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
        idle += c.times.idle;
      }
      const memTotal = os.totalmem();
      const raw: PerfSshRaw = {
        t: Date.now(),
        cpuTotal: total,
        cpuIdle: idle,
        perCore,
        cores: Math.max(1, cpus.length),
        // Windows has no load average (os.loadavg() is always zeros).
        load: process.platform === 'win32' ? undefined : (os.loadavg() as [number, number, number]),
        memTotalKb: memTotal / 1024,
        memAvailKb: os.freemem() / 1024,
        swapTotalKb: 0,
        swapFreeKb: 0,
        diskUsedPct: disk?.usedPct,
        disks: disk ? [disk] : undefined,
        uptimeSec: os.uptime(),
      };
      return { ok: true, raw };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  async sampleK8s(target: unknown): Promise<PerfK8sResult> {
    if (!isValidPerfK8sTarget(target)) return { ok: false, reason: 'error' };
    try {
      const [kc, { CustomObjectsApi, CoreV1Api }] = await Promise.all([
        loadKubeConfigForContext(target.contextName, this.kubeConfigPath),
        loadK8sClient(),
      ]);
      const [metricsRes, podRes] = await Promise.allSettled([
        kc.makeApiClient(CustomObjectsApi).getNamespacedCustomObject({
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          namespace: target.namespace,
          plural: 'pods',
          name: target.podName,
        }),
        kc.makeApiClient(CoreV1Api).readNamespacedPod({ name: target.podName, namespace: target.namespace }),
      ]);

      if (metricsRes.status === 'rejected') {
        const status = statusOf(metricsRes.reason);
        if (status === 403) return { ok: false, reason: 'forbidden' };
        if (status === 404) return { ok: false, reason: 'no-metrics' };
        return { ok: false, reason: 'error' };
      }

      const metrics = metricsRes.value as {
        containers?: Array<{ name?: string; usage?: { cpu?: string; memory?: string } }>;
      };
      const usage = metrics.containers?.find((c) => c.name === target.containerName)?.usage;
      if (!usage) return { ok: false, reason: 'no-metrics' };

      const raw: PerfK8sRaw = {
        t: Date.now(),
        cpuMillicores: parseCpuMillicores(usage.cpu),
        memBytes: parseMemBytes(usage.memory),
        restarts: 0,
      };
      if (podRes.status === 'fulfilled') {
        const pod = podRes.value;
        const resources = pod.spec?.containers?.find((c) => c.name === target.containerName)?.resources;
        const limits = resources?.limits;
        const requests = resources?.requests;
        if (limits?.cpu) raw.cpuLimitMillicores = parseCpuMillicores(limits.cpu);
        if (limits?.memory) raw.memLimitBytes = parseMemBytes(limits.memory);
        if (requests?.cpu) raw.cpuRequestMillicores = parseCpuMillicores(requests.cpu);
        if (requests?.memory) raw.memRequestBytes = parseMemBytes(requests.memory);
        const readyCond = pod.status?.conditions?.find((c) => c.type === 'Ready');
        if (readyCond) raw.ready = readyCond.status === 'True';
        const created = pod.metadata?.creationTimestamp;
        if (created) {
          const ms = new Date(created).getTime();
          if (Number.isFinite(ms)) raw.createdAt = ms;
        }
        raw.nodeName = pod.spec?.nodeName;
        raw.restarts =
          pod.status?.containerStatuses?.find((c) => c.name === target.containerName)?.restartCount ?? 0;
        raw.phase = pod.status?.phase;
      }
      return { ok: true, raw };
    } catch (err) {
      return { ok: false, reason: statusOf(err) === 403 ? 'forbidden' : 'error' };
    }
  }
}
