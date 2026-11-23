import { fileCommands } from "./commands/files";
import { netCommands } from "./commands/net";
import { systemCommands } from "./commands/system";
import { scoreScenario, type ScenarioScore, type SimScenario } from "./Scenario";
import { cephNearfull } from "./scenarios/cephNearfull";
import { certRenewal } from "./scenarios/certRenewal";
import { factsDriftStaleRunbook } from "./scenarios/factsDriftStaleRunbook";
import { k8sPvcMountCascade } from "./scenarios/k8sPvcMountCascade";
import { nginxBadConfig } from "./scenarios/nginxBadConfig";
import { ontapNoisyNeighbour } from "./scenarios/ontapNoisyNeighbour";
import { pgWalFull } from "./scenarios/pgWalFull";
import { upstream502Rollback } from "./scenarios/upstream502Rollback";
import { baseWorld, setSimWorld, simWorld, SimWorld } from "./SimWorld";

/** The incidents the lab can play. */
export const SCENARIOS: SimScenario[] = [
  pgWalFull,
  nginxBadConfig,
  certRenewal,
  ontapNoisyNeighbour,
  cephNearfull,
  k8sPvcMountCascade,
  upstream502Rollback,
  factsDriftStaleRunbook,
];

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

/**
 * Puts a scenario's servers in a new lab, with its fault in them. The incident's lab that was there is
 * gone. The servers that are always there in a demo (the base fleet) are not: the new lab has them
 * behind it, as they stand, and is judged on its own servers only.
 */
export function startScenario(scenario: SimScenario, clock?: () => number): SimWorld {
  const world = emptyLab(clock);
  world.building = true;
  scenario.build(world);
  world.building = false;
  for (const host of world.hosts.values()) host.settingUp = false;
  world.settle();
  world.behind = baseWorld();
  setSimWorld(world);
  running = scenario;
  return world;
}

/** The scenario the lab is playing, if any. */
export const runningScenario = (): SimScenario | undefined => running;

/** Takes the lab back to having no scenario: its servers are gone, and the ones that are always there stay. */
export function stopScenario(): void {
  running = undefined;
  setSimWorld(undefined);
}

/** How the running scenario stands, judged from the lab and from a report when there is one. */
export function scoreRunning(report?: string): ScenarioScore | undefined {
  return running ? scoreScenario(running, { world: simWorld(), report }) : undefined;
}
