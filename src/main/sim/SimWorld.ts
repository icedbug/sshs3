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
  private offset = 0;

  constructor(private readonly base: () => number = Date.now) {}

  /** What time it is in the lab. */
  now = (): number => this.base() + this.offset;

  /** Moves the lab's clock: a scenario that needs "an hour later". */
  advance(ms: number): void {
    this.offset += ms;
  }

  addHost(init: SimHostInit, ...aliases: string[]): SimHost {
    const host = new SimHost(init, this.now);
    this.hosts.set(init.name.toLowerCase(), host);
    for (const alias of [init.address, ...aliases]) if (alias) this.aliases.set(alias.toLowerCase(), init.name.toLowerCase());
    this.names.set(init.name.toLowerCase(), init.address);
    return host;
  }

  /** A host by its name, its address, or another name it was given. */
  host(...refs: (string | undefined)[]): SimHost | undefined {
    for (const ref of refs) {
      const key = ref?.trim().toLowerCase();
      if (!key) continue;
      const found = this.hosts.get(key) ?? this.hosts.get(this.aliases.get(key) ?? "");
      if (found) return found;
    }
    return undefined;
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

  /** A new shell on a host: its own working directory, the host's one state. */
  shell(host: SimHost): SimShell {
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

/** The lab as it stands. Empty until something put servers in it. */
export function simWorld(): SimWorld {
  return (current ??= new SimWorld());
}

/** Puts a new lab in place: what a scenario does when it starts, and a test before each case. */
export function setSimWorld(world: SimWorld | undefined): void {
  current = world;
}
