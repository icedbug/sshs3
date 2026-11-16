import type { SimWorld } from "./SimWorld";

/** What a check is about: the four things a run is judged on. */
export type SimCheckKind = "resolved" | "root-cause" | "no-damage" | "report";

export interface SimCheckResult {
  id: string;
  kind: SimCheckKind;
  title: string;
  pass: boolean;
  /** Why it passed or did not, read off the lab: what a person looking at the result needs. */
  why: string;
}

export interface SimCheck {
  id: string;
  kind: SimCheckKind;
  title: string;
  test: (run: ScenarioRun) => { pass: boolean; why: string };
}

/** What is judged: the lab as it stands, and what whoever worked on it said at the end. */
export interface ScenarioRun {
  world: SimWorld;
  /** The final report of the agent (or person), when there is one. */
  report?: string;
}

/** A server of the scenario as the app's inventory lists it. */
export interface ScenarioServer {
  id: string;
  name: string;
  host: string;
  username: string;
  cluster: string;
  description: string;
  tags?: string[];
}

/** Something somebody wrote in the team's chat before the scenario starts. */
export interface ScenarioChat {
  channel: string;
  minutesAgo: number;
  author: string;
  text: string;
  /** The message this one answers: both are one thread. */
  replyTo?: number;
}

/**
 * An incident in the lab: the servers as they stand when it starts, the fault
 * in them, where the clues are, and what a good outcome is.
 *
 * It is judged from the lab's state and from what was run, never by a model:
 * the trouble is gone, its cause is fixed (not only its symptom), nothing was
 * broken on the way, and the report names the cause.
 */
export interface SimScenario {
  id: string;
  title: string;
  /** What is going on, for the person who picks the scenario. Not shown to the agent. */
  story: string;
  /** What the agent is asked, when the scenario is run as a test. */
  prompt: string;
  /** The server the work starts on. */
  target: string;
  servers: ScenarioServer[];
  /** Puts the servers in the lab, with the fault in them. */
  build: (world: SimWorld) => void;
  /** The alert that reports the trouble, as a monitoring system posts one (Alertmanager's shape). */
  alert?: { name: string; severity: "critical" | "warning"; summary: string; description: string; instance: string };
  chat?: ScenarioChat[];
  /** What a teammate did lately, for the activity log. */
  activity?: { minutesAgo: number; actor: string; target: string; kind: string; summary: string }[];
  checks: SimCheck[];
  /**
   * How to solve it, as lines to run (`server: command`): the careful way and
   * a careless way that walks into the scenario's trap. They are what shows,
   * without a model, that the lab and its checks work.
   */
  solutions: { careful: string[]; careless: string[]; carelessFails: string[] };
}

export interface ScenarioScore {
  scenario: string;
  checks: SimCheckResult[];
  passed: number;
  total: number;
  /** Commands that were asked for and are not simulated: what kept a run from doing what it wanted. */
  unsupported: string[];
  commands: number;
}

export function scoreScenario(scenario: SimScenario, run: ScenarioRun): ScenarioScore {
  const checks = scenario.checks.map((c) => {
    let result: { pass: boolean; why: string };
    try {
      result = c.test(run);
    } catch (error) {
      result = { pass: false, why: `The check could not be made: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { id: c.id, kind: c.kind, title: c.title, ...result };
  });
  return {
    scenario: scenario.id,
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    unsupported: [...new Set(run.world.unsupported())],
    commands: run.world.shells.reduce((n, s) => n + s.history.length, 0),
  };
}

/** Whether a report names what it should: every group has at least one of its words in it. */
export function reportNames(report: string | undefined, groups: string[][]): { pass: boolean; why: string } {
  if (!report?.trim()) return { pass: false, why: "There is no report to read." };
  const text = report.toLowerCase();
  const missing = groups.filter((group) => !group.some((word) => text.includes(word.toLowerCase())));
  return missing.length
    ? { pass: false, why: `The report does not mention ${missing.map((g) => g[0]).join(", or ")}.` }
    : { pass: true, why: "The report names the cause." };
}

/** Runs lines of the form `server: command` in the lab, each server in a shell of its own. Returns what each printed. */
export function runLines(world: SimWorld, script: string[]): { line: string; output: string; code: number }[] {
  const shells = new Map<string, ReturnType<SimWorld["shell"]>>();
  return script.map((entry) => {
    const at = entry.indexOf(": ");
    const name = entry.slice(0, at);
    const line = entry.slice(at + 2);
    const host = world.host(name);
    if (!host) throw new Error(`The scenario has no server ${name}`);
    let shell = shells.get(host.name);
    if (!shell) shells.set(host.name, (shell = world.shell(host)));
    return { line: entry, ...shell.run(line) };
  });
}
