import { fileCommands } from "./commands/files";
import { netCommands } from "./commands/net";
import { systemCommands } from "./commands/system";
import { scoreScenario, type ScenarioScore, type SimScenario } from "./Scenario";
import { pgWalFull } from "./scenarios/pgWalFull";
import { setSimWorld, simWorld, SimWorld } from "./SimWorld";

/** The incidents the lab can play. */
export const SCENARIOS: SimScenario[] = [pgWalFull];

export const scenarioById = (id: string): SimScenario | undefined => SCENARIOS.find((s) => s.id === id);

let running: SimScenario | undefined;

/** A lab with the commands every server has, and nothing in it yet. */
export function emptyLab(clock?: () => number): SimWorld {
  const world = new SimWorld(clock);
  world.register(fileCommands);
  world.register(systemCommands);
  world.register(netCommands);
  return world;
}

/** Puts a scenario's servers in a new lab, with its fault in them. The lab that was there is gone. */
export function startScenario(scenario: SimScenario, clock?: () => number): SimWorld {
  const world = emptyLab(clock);
  scenario.build(world);
  setSimWorld(world);
  running = scenario;
  return world;
}

/** The scenario the lab is playing, if any. */
export const runningScenario = (): SimScenario | undefined => running;

/** Takes the lab back to having no scenario: the scripted demo appliances answer again. */
export function stopScenario(): void {
  running = undefined;
  setSimWorld(undefined);
}

/** How the running scenario stands, judged from the lab and from a report when there is one. */
export function scoreRunning(report?: string): ScenarioScore | undefined {
  return running ? scoreScenario(running, { world: simWorld(), report }) : undefined;
}
