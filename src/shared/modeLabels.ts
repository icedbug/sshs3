import type { AgentMode } from "./types/aiHub";

/**
 * The modes as a person knows them, wherever one is named to a person (the panel, the agents list, the
 * audit log): "assisted" is the code's word for "Ask first". "Ask" next to "Ask first" was read as the
 * same thing, so the mode that only answers is "Advice".
 */
export const MODE_LABEL: Record<AgentMode, string> = {
  advice: "Advice",
  assisted: "Ask first",
  autonomous: "Auto",
  plan: "Plan",
};

/** The mode's name for a person, or the stored word when it is none of the four. */
export function modeLabel(mode: string | undefined): string {
  return (mode && (MODE_LABEL as Record<string, string>)[mode]) || mode || "";
}
