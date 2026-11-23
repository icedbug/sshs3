import { isIPv4 } from "node:net";
import { SimHost, type SimHostInit } from "./SimHost";
import { SimShell, type SimCommand } from "./SimShell";

/**
 * The simulated lab: its servers, its clock, and the commands that can be run
 * on them. One world at a time: starting a scenario puts a new one in place.
 */
export class SimWorld {
  readonly hosts = new Map<string, SimHost>();
  /** Other names a host answers to: its address, a saved server's id. */
  private readonly aliases = new Map<string, string>();
  readonly commands = new Map<string, SimCommand>();
  /**
   * The lab's name service: which names lead where. A name that is not here
   * does not resolve, which is how a decommissioned gateway looks from a server.
   */
  readonly names = new Map<string, string>();
  /**
   * Things on the lab's network that are not servers one can log in to: an S3
   * gateway, an ACME service. By `name:port`; each answers a request.
   */
  readonly endpoints = new Map<string, (path: string, from: SimHost) => { status: number; body: string }>();
  /** The shells that were opened, for what was run in them. */
  readonly shells: SimShell[] = [];
  /** Multi-host causality laws run after commands and clock advances. */
  readonly laws: Array<(world: SimWorld) => void> = [];
  private offset = 0;
  /** Called after a command was run on one of the lab's servers. */
  onRan?: () => void;
  /** Set while a scenario builds its servers: see `SimHost.settingUp`. */
  building = false;
  /**
   * The servers that are always there, beside this lab's own: an incident's lab has the demo's base
   * fleet behind it. They are found from here by name, and they keep their own commands, names, clock
   * and state: what is run on them is no part of this lab's score, and they are still there, as they
   * were left, when this lab is gone.
   */
  behind?: SimWorld;

  constructor(private readonly base: () => number = Date.now) {}

  /** What time it is in the lab. */
  now = (): number => this.base() + this.offset;

  /** Moves the lab's clock: a scenario that needs "an hour later". */
  advance(ms: number): void {
    this.offset += ms;
    this.settle();
  }

  /** Runs world-level cross-host laws. */
  runLaws(): void {
    for (const law of this.laws) law(this);
  }

  /** Settles every host and then runs world-level laws. */
  settle(): void {
    for (const host of this.hosts.values()) host.settle();
    this.runLaws();
  }

  addHost(init: SimHostInit, ...aliases: string[]): SimHost {
    const host = new SimHost(init, this.now);
    host.settingUp = this.building;
    this.hosts.set(init.name.toLowerCase(), host);
    for (const alias of [init.address, ...aliases]) if (alias) this.aliases.set(alias.toLowerCase(), init.name.toLowerCase());
    this.names.set(init.name.toLowerCase(), init.address);
    return host;
  }

  /**
   * A host by its name, its address, or another name it was given: one of this lab's, or one of the
   * lab behind it. Each name is tried in both before the next, so a server's own name always finds it,
   * whatever address another server shares with it.
   */
  host(...refs: (string | undefined)[]): SimHost | undefined {
    for (const ref of refs) {
      const key = ref?.trim().toLowerCase();
      if (!key) continue;
      const found = this.hosts.get(key) ?? this.hosts.get(this.aliases.get(key) ?? "") ?? this.behind?.host(key);
      if (found) return found;
    }
    return undefined;
  }

  /** Every server that answers from here: this lab's own, then the ones behind it. */
  everyHost(): SimHost[] {
    return [...this.hosts.values(), ...(this.behind?.everyHost() ?? [])];
  }

  /** The lab a host is in: this one, or the one behind it. */
  worldOf(host: SimHost): SimWorld {
    return this.hosts.get(host.name.toLowerCase()) === host ? this : (this.behind?.worldOf(host) ?? this);
  }

  /** The address a name leads to, or nothing when it does not resolve. An address is its own answer. */
  resolve(name: string): string | undefined {
    const key = name.trim().toLowerCase();
    if (isIPv4(key)) return key;
    return this.names.get(key) ?? this.names.get(key.split(".")[0]);
  }

  register(commands: Record<string, SimCommand>): void {
    for (const [name, command] of Object.entries(commands)) this.commands.set(name, command);
  }

  /** A new shell on a host: its own working directory, the host's one state. A host of the lab behind this one gets that lab's commands. */
  shell(host: SimHost): SimShell {
    const owner = this.worldOf(host);
    if (owner !== this) return owner.shell(host);
    const shell = new SimShell(host, this.commands, this);
    this.shells.push(shell);
    return shell;
  }

  /** Every line run on a host, in any shell, oldest first. */
  ran(host: SimHost): { at: number; line: string; code: number; root: boolean }[] {
    return this.shells
      .filter((s) => s.host === host)
      .flatMap((s) => s.history)
      .sort((a, b) => a.at - b.at);
  }

  /** What was asked for and is not simulated, across the lab. */
  unsupported(): string[] {
    return this.shells.flatMap((s) => s.unsupported);
  }
}

let current: SimWorld | undefined;
let base: SimWorld | undefined;
let empty: SimWorld | undefined;

/**
 * The lab as it stands: the one an incident put in place, else the servers that are always there,
 * else a lab with nothing in it.
 */
export function simWorld(): SimWorld {
  return current ?? base ?? (empty ??= new SimWorld());
}

/**
 * Puts an incident's lab in place, or takes it away again (`undefined`). The servers that are always
 * there stay: an incident's lab has them behind it (`SimWorld.behind`).
 */
export function setSimWorld(world: SimWorld | undefined): void {
  current = world;
  empty = undefined;
}

/** The servers that are always there in a demo process (sim/baseFleet.ts), if they were built. */
export function baseWorld(): SimWorld | undefined {
  return base;
}

/** Puts the always-there servers in place. A lab that is running gets them behind it at once. */
export function setBaseWorld(world: SimWorld | undefined): void {
  base = world;
  if (current && current !== world) current.behind = world;
}

let baseFleetOn = true;

/** Whether a demo process has its always-there servers. It does, unless a test switched them off. */
export function baseFleetWanted(): boolean {
  return baseFleetOn;
}

/**
 * Test-only: a test of the scripted example servers behind the base fleet runs without the fleet.
 * Throws outside Vitest, so application code cannot switch the fleet off.
 */
export function setBaseFleetForTesting(on: boolean): void {
  if (!process.env.VITEST) throw new Error("The demo's base fleet is always on outside tests");
  baseFleetOn = on;
  if (!on) setBaseWorld(undefined);
}

/** Test-only: no lab, no always-there servers, and the fleet wanted again. Run after every test (tests/setup/freshLab.ts). */
export function resetLabForTesting(): void {
  if (!process.env.VITEST) throw new Error("The lab is reset between tests only");
  current = undefined;
  base = undefined;
  empty = undefined;
  baseFleetOn = true;
}
