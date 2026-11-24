import { isDemoTarget } from "../demo/demoMode";
import { simWorld } from "./SimWorld";

/**
 * Said to a model together with a result that came from one of the demo lab's scripted example
 * servers. Those servers print the same invented text whatever is asked of them, and a model that
 * is not told takes it for the state of a system: on the first run with a real model, an agent
 * ruled a real alert out because the example cluster beside it said HEALTH_OK.
 */
export const SCRIPTED_DEMO_NOTE =
  "This server is one of the demo lab's scripted examples: what it prints is invented and never changes. It is not evidence about any system, and it says nothing about another server or cluster.";

/**
 * Said with what a simulated server of the base fleet printed when its appliance's program answered
 * from the showcase's script (programs/showcase.ts): the same invented text the scripted example
 * servers print, not this server's own state.
 */
export const SCRIPTED_ANSWER_NOTE =
  "This answer comes from the demo lab's script, not from this server's own state: it is invented. It is not evidence about any system, and it says nothing about another server or cluster.";

/**
 * The note, when the server these names belong to is a scripted example. Nothing for a real server.
 * A simulated one (a server of a running scenario, or of the base fleet) holds state, and what it
 * prints is true of it: it gets a note only for a line whose answer came from the script (`line`,
 * as it was run there).
 */
export function scriptedDemoNote(line: string | undefined, ...refs: Array<string | undefined>): string | undefined {
  const named = refs.filter((r): r is string => Boolean(r));
  if (!named.length || !isDemoTarget(...named)) return undefined;
  const host = simWorld().host(...named);
  if (!host) return SCRIPTED_DEMO_NOTE;
  const wanted = line?.trim();
  if (!wanted) return undefined;
  // The latest run of this line on the server, in any of its shells: the one that just answered.
  // A base fleet server's shells are kept by the fleet, also while a scenario runs in front of it.
  const ran = simWorld().worldOf(host).ran(host).filter((entry) => entry.line.trim() === wanted).at(-1);
  return ran?.scripted ? SCRIPTED_ANSWER_NOTE : undefined;
}
