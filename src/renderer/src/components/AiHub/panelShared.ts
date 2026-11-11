import type { AgentMode, HubRequest, HubSnapshot } from "@shared/types/aiHub";

/** The panel's request helper: it shows a failed request in the panel and resolves with nothing. */
export type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;

/**
 * The Demo-Lab toggles: on the desktop, main asks for confirmation and then restarts sshs3 in the other
 * mode; in web mode demo mode is fixed when the server starts, so they are shown disabled with this title.
 */
export const DEMO_MODE_SET_BY_SERVER =
  "Demo mode is set when the sshs3 server starts and can't be changed here.";

export const modes: Record<AgentMode, string> = {
  advice: "Ask",
  assisted: "Ask first",
  autonomous: "Auto",
};
