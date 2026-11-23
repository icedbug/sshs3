/**
 * One simulated server: what is on it, and what follows from that.
 *
 * Everything a command answers is read from this state, and a command that
 * changes something changes it here: a fault exists until somebody fixes it,
 * and a careless fix leaves its marks. Nothing runs on a timer. The same
 * state gives the same answer, so a scenario can be replayed and judged.
 */

export interface SimFile {
  content: string;
  /** Bytes the file takes beyond its text: a big file (a WAL segment, a dump) whose contents are not kept. */
  pad?: number;
  mode: number;
  owner: string;
  mtime: number;
}

export type SimServiceState = "active" | "failed" | "inactive";

export interface SimService {
  name: string;
  description: string;
  state: SimServiceState;
  enabled: boolean;
  /** When it came to the state it has. */
  since: number;
  pid?: number;
  user?: string;
  /** The ports it listens on while it runs. */
  ports?: { proto: "tcp" | "udp"; port: number; address?: string }[];
  /**
   * Why it cannot start as things stand, or nothing when it can. Asked every
   * time somebody starts, restarts or reloads it: a service with a broken
   * configuration stays down until the configuration is fixed.
   */
  check?: (host: SimHost) => string | undefined;
  /**
   * Whether it does its job right now, apart from running: a database that is
   * up but cannot write. Asked by `curl`, by clients, and by a scenario's checks.
   */
  healthy?: (host: SimHost) => string | undefined;
  /**
   * Called when it has started or reloaded: the moment a program takes in its
   * configuration. What a file says and what the running program goes by are
   * two things until then.
   */
  applied?: (host: SimHost) => void;
  /** What `ExecStart` is, for `systemctl status` and `ps`. */
  command?: string;
}

export interface SimDisk {
  mount: string;
  device: string;
  fs: string;
  sizeKb: number;
  /** Used by what is not kept as files (the system itself). */
  baseUsedKb: number;
}

export interface SimCert {
  subject: string;
  issuer: string;
  notBefore: number;
  notAfter: number;
  /** Names it is valid for. */
  names: string[];
}

export interface SimLogLine {
  at: number;
  unit: string;
  text: string;
  /** syslog priority: 3 error, 4 warning, 6 info. */
  priority?: number;
}

export interface SimPeer {
  localPort: number;
  remoteIp: string;
  remotePort: number;
  process?: string;
}

export interface SimHostInit {
  name: string;
  address: string;
  os?: { id: string; version: string; pretty: string };
  kernel?: string;
  /** How long it has been up when the scenario starts, in seconds. */
  uptimeSeconds?: number;
  /** Which kind of shell answers: a Linux server, or an appliance with a command line of its own. */
  kind?: "linux" | "ontap" | "ceph";
  user?: string;
  memoryMb?: number;
  cpus?: number;
  peers?: SimPeer[];
}

const DIR_SIZE_KB = 4;

export const normalizePath = (path: string, cwd = "/"): string => {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};
export const dirname = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
};
export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export class SimHost {
  readonly name: string;
  readonly address: string;
  readonly kind: "linux" | "ontap" | "ceph";
  os: { id: string; version: string; pretty: string };
  kernel: string;
  bootAt: number;
  user: string;
  memoryMb: number;
  cpus: number;
  readonly files = new Map<string, SimFile>();
  private readonly dirs = new Set<string>(["/", "/tmp", "/var", "/var/tmp"]);
  readonly services = new Map<string, SimService>();
  disks: SimDisk[] = [];
  packages: Record<string, string> = {};
  readonly certs = new Map<string, SimCert>();
  readonly journal: SimLogLine[] = [];
  /** Established outbound TCP peers for ss and ServerFacts dependency discovery. */
  peers?: SimPeer[];
  /** Anything a scenario keeps on the host that is not a file: an appliance's volumes, a database's settings. */
  readonly facts = new Map<string, unknown>();
  /**
   * What happens by itself on this server, given how it stands: a database
   * that archives its logs once it can reach the archive, a disk that fills
   * while it cannot. Applied after every command, and only then: nothing
   * moves on a timer, so the same commands always lead to the same state.
   */
  readonly laws: ((host: SimHost) => void)[] = [];
  /**
   * Programs of the server's own that can be run by their path: a script a
   * scenario put there. What the script does is played by the function.
   */
  readonly programs = new Map<string, (ctx: never, args: string[]) => { out: string; err: string; code: number }>();
  /**
   * While a scenario is putting the server together, a file written without a
   * time of its own is as old as the server, not from this minute: nobody
   * looking at `ls -l` should think the whole machine was edited just now.
   */
  settingUp = false;
  /** When set, only these commands exist here: an appliance with a command line of its own. */
  only?: { commands: Set<string>; unknown: (name: string) => string };
  /** Extra processes beside the services', for `ps`. */
  processes: { pid: number; user: string; cpu: number; mem: number; command: string }[] = [];
  private nextPid = 2000;

  constructor(
    init: SimHostInit,
    /** The world's clock: a scenario decides what time it is. */
    readonly now: () => number = Date.now,
  ) {
    this.name = init.name;
    this.address = init.address;
    this.kind = init.kind ?? "linux";
    if (init.peers) this.peers = init.peers.map((p) => ({ ...p }));
    this.os = init.os ?? { id: "ubuntu", version: "24.04", pretty: "Ubuntu 24.04.1 LTS" };
    this.kernel = init.kernel ?? "6.8.0-45-generic";
    this.bootAt = this.now() - (init.uptimeSeconds ?? 41 * 86_400) * 1000;
    this.user = init.user ?? "ops";
    this.memoryMb = init.memoryMb ?? 16_384;
    this.cpus = init.cpus ?? 8;
  }

  // ---- files -----------------------------------------------------------------

  mkdir(path: string): void {
    let at = normalizePath(path);
    while (at !== "/" && !this.dirs.has(at)) {
      this.dirs.add(at);
      at = dirname(at);
    }
  }

  isDir(path: string): boolean {
    return this.dirs.has(normalizePath(path));
  }

  exists(path: string): boolean {
    const p = normalizePath(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  read(path: string): SimFile | undefined {
    return this.files.get(normalizePath(path));
  }

  /** Writes a file, making the folders above it. Keeps mode and owner of a file that is there. */
  write(path: string, content: string, extra: Partial<Pick<SimFile, "pad" | "mode" | "owner" | "mtime">> = {}): SimFile {
    const p = normalizePath(path);
    this.mkdir(dirname(p));
    const had = this.files.get(p);
    const file: SimFile = {
      content,
      pad: extra.pad ?? 0,
      mode: extra.mode ?? had?.mode ?? 0o644,
      owner: extra.owner ?? had?.owner ?? "root",
      mtime: extra.mtime ?? (this.settingUp ? this.bootAt - 19 * 86_400_000 : this.now()),
    };
    this.files.set(p, file);
    return file;
  }

  /** Removes a file, or a folder with everything in it. Returns how many files went. */
  remove(path: string): number {
    const p = normalizePath(path);
    if (this.files.delete(p)) return 1;
    if (!this.dirs.has(p) || p === "/") return 0;
    let gone = 0;
    for (const file of [...this.files.keys()]) if (file.startsWith(`${p}/`)) gone += Number(this.files.delete(file));
    for (const dir of [...this.dirs]) if (dir === p || dir.startsWith(`${p}/`)) this.dirs.delete(dir);
    return gone;
  }

  /** What is directly in a folder: names, folders marked. */
  list(path: string): { name: string; dir: boolean }[] {
    const p = normalizePath(path);
    const prefix = p === "/" ? "/" : `${p}/`;
    const out = new Map<string, boolean>();
    for (const dir of this.dirs) if (dir !== p && dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) out.set(dir.slice(prefix.length), true);
    for (const file of this.files.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) out.set(file.slice(prefix.length), false);
    return [...out.entries()].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every file under a folder, itself included when it is a file. */
  under(path: string): string[] {
    const p = normalizePath(path);
    if (this.files.has(p)) return [p];
    const prefix = p === "/" ? "/" : `${p}/`;
    return [...this.files.keys()].filter((f) => f.startsWith(prefix)).sort();
  }

  sizeOf(file: SimFile): number {
    return Buffer.byteLength(file.content, "utf8") + (file.pad ?? 0);
  }

  /** Bytes under a path. */
  usage(path: string): number {
    let bytes = 0;
    for (const f of this.under(path)) bytes += this.sizeOf(this.files.get(f)!);
    return bytes;
  }

  // ---- disks -----------------------------------------------------------------

  /** The filesystem a path is on: the longest mount point above it. */
  diskOf(path: string): SimDisk | undefined {
    const p = normalizePath(path);
    return [...this.disks].sort((a, b) => b.mount.length - a.mount.length).find((d) => d.mount === "/" || p === d.mount || p.startsWith(`${d.mount}/`));
  }

  /** How full a filesystem is, counted from what is on it. */
  diskUse(disk: SimDisk): { usedKb: number; availKb: number; pct: number } {
    let bytes = 0;
    for (const [path, file] of this.files) if (this.diskOf(path) === disk) bytes += this.sizeOf(file);
    const usedKb = Math.min(disk.sizeKb, disk.baseUsedKb + Math.ceil(bytes / 1024) + DIR_SIZE_KB);
    return { usedKb, availKb: disk.sizeKb - usedKb, pct: Math.min(100, Math.ceil((usedKb / disk.sizeKb) * 100)) };
  }

  /** Whether `bytes` more fit where `path` is. A full disk refuses the write, as a real one does. */
  hasRoomFor(path: string, bytes: number): boolean {
    const disk = this.diskOf(path);
    return !disk || this.diskUse(disk).availKb * 1024 >= bytes;
  }

  // ---- services --------------------------------------------------------------

  addService(service: Omit<SimService, "since" | "state" | "enabled"> & Partial<Pick<SimService, "since" | "state" | "enabled">>): SimService {
    const made: SimService = { state: "active", enabled: true, since: this.bootAt + 60_000, ...service };
    if (made.state === "active") made.pid ??= this.nextPid++;
    this.services.set(made.name, made);
    return made;
  }

  /** A unit by the name people type: `nginx` and `nginx.service` are the same. */
  service(name: string): SimService | undefined {
    return this.services.get(name.replace(/\.service$/, ""));
  }

  log(unit: string, text: string, priority = 6, at = this.now()): void {
    this.journal.push({ at, unit, text, priority });
    if (this.journal.length > 5000) this.journal.splice(0, this.journal.length - 5000);
  }

  /** Starts a service if it can start. Says why not when it cannot, and leaves it failed. */
  start(name: string): string | undefined {
    const service = this.service(name);
    if (!service) return `Unit ${name.replace(/\.service$/, "")}.service not found.`;
    const why = service.check?.(this);
    if (why) {
      service.state = "failed";
      service.pid = undefined;
      service.since = this.now();
      this.log(service.name, why, 3);
      this.log("systemd", `${service.name}.service: Failed with result 'exit-code'.`, 3);
      this.log("systemd", `Failed to start ${service.name}.service - ${service.description}.`, 3);
      return why;
    }
    if (service.state !== "active") {
      service.state = "active";
      service.pid = this.nextPid++;
      service.since = this.now();
      this.log("systemd", `Started ${service.name}.service - ${service.description}.`);
      service.applied?.(this);
    }
    return undefined;
  }

  stop(name: string): string | undefined {
    const service = this.service(name);
    if (!service) return `Unit ${name.replace(/\.service$/, "")}.service not found.`;
    if (service.state === "active") this.log("systemd", `Stopped ${service.name}.service - ${service.description}.`);
    service.state = "inactive";
    service.pid = undefined;
    service.since = this.now();
    return undefined;
  }

  restart(name: string): string | undefined {
    const service = this.service(name);
    if (!service) return `Unit ${name.replace(/\.service$/, "")}.service not found.`;
    // Stopped first, as systemd does: a service that cannot start again is down after a restart.
    this.stop(name);
    return this.start(name);
  }

  /** Reloads the configuration of a running service: refused, and the service left as it runs, when the configuration is bad. */
  reload(name: string): string | undefined {
    const service = this.service(name);
    if (!service) return `Unit ${name.replace(/\.service$/, "")}.service not found.`;
    if (service.state !== "active") return `${service.name}.service is not active, cannot reload.`;
    const why = service.check?.(this);
    if (why) {
      this.log(service.name, why, 3);
      this.log("systemd", `${service.name}.service: Control process exited, code=exited, status=1/FAILURE`, 3);
      return why;
    }
    this.log("systemd", `Reloaded ${service.name}.service - ${service.description}.`);
    service.applied?.(this);
    return undefined;
  }

  /** Lets what follows from the state follow: called after every command. */
  settle(): void {
    for (const law of this.laws) law(this);
  }

  /** What is listening: the ports of the services that run. */
  listening(): { proto: "tcp" | "udp"; address: string; port: number; process: string; pid?: number }[] {
    return [...this.services.values()]
      .filter((s) => s.state === "active")
      .flatMap((s) => (s.ports ?? []).map((p) => ({ proto: p.proto, address: p.address ?? "0.0.0.0", port: p.port, process: s.name, pid: s.pid })))
      .sort((a, b) => a.port - b.port);
  }
}
