import { describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "../../src/main/ai/hub/toolSchemas";

/**
 * A command or a change runs in the conversation's own terminal unless it names another. In the lab an
 * agent asked about a fault on app-01 from a terminal on web-01 put a change card in web-01's terminal:
 * nothing told it that it could open a terminal on app-01 and aim the card there.
 */
describe("the tools that run commands say how to reach another server", () => {
  it.each(["terminal_command", "terminal_verify", "sshs3_change"])("%s", (name) => {
    const tool = AGENT_TOOLS.find((t) => t.name === name);
    const sessionId = (tool?.parameters.properties as Record<string, { description?: string }> | undefined)?.sessionId?.description ?? "";
    expect(sessionId).toMatch(/this conversation's terminal/);
    expect(sessionId).toMatch(/sshs3_workspace_layout \(open_terminal\)/);
    expect(sessionId).toMatch(/workspace_context/);
  });
});
