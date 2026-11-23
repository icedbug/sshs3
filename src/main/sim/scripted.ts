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
 * The note, when the server these names belong to is a scripted example. Nothing for a real server,
 * and nothing for a simulated one (a server of a running scenario, or of the base fleet): that one
 * holds state, and what it prints is true of it.
 */
export function scriptedDemoNote(...refs: Array<string | undefined>): string | undefined {
  const named = refs.filter((r): r is string => Boolean(r));
  if (!named.length || !isDemoTarget(...named)) return undefined;
  return simWorld().host(...named) ? undefined : SCRIPTED_DEMO_NOTE;
}
