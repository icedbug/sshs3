import { describe, expect, it } from "vitest";
import { ACP_WORKSPACE_TOOLS, acpWorkspaceAllowlist } from "../../src/shared/acpWorkspaceTools";
import { toolsForScopes } from "../../src/main/web/mcp/mcpTools";

describe("the external agent's workspace tool selection", () => {
  it("offers only tools actually served under ACP run scopes", () => {
    const available = toolsForScopes(["read", "run"]);
    expect(ACP_WORKSPACE_TOOLS.map(t => [t.name, t.scope]).sort()).toEqual(available.map(t => [t.name, t.scope]).sort());
    const selected = acpWorkspaceAllowlist(["kb_search", "sshs3_tickets", "kb_search", "file_read"])!;
    expect(toolsForScopes(["read"]).filter(t => selected.includes(t.name)).map(t => t.name)).toEqual(["kb_search", "tickets_list"]);
  });
  it("distinguishes unsupported restrictions from an unrestricted token", () => {
    expect(acpWorkspaceAllowlist(["file_write", "unknown"])).toEqual([]);
    expect(acpWorkspaceAllowlist(["all"])).toBeUndefined();
    expect(acpWorkspaceAllowlist(undefined)).toBeUndefined();
  });
});
