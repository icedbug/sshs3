// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot, WorkTicket } from "../../src/shared/types/aiHub";
import { atlassianSummary } from "../../src/renderer/src/components/AiHub/AtlassianCard";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";

afterEach(cleanup);

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "backlog",
  createdBy: "Jira",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const hub = (extra: Partial<HubSnapshot>): HubSnapshot =>
  ({
    tasks: [],
    sessions: [],
    agents: [],
    workGoals: [],
    workTickets: [],
    agentUsage: {},
    workforceTemplates: [],
    workBoardSync: { shared: false },
    preferences: {},
    ...extra,
  }) as unknown as HubSnapshot;

describe("a ticket that mirrors a Jira issue", () => {
  const mirrored = ticket("t-jira-1", {
    title: "OPS-12: Disk almost full",
    outside: "Jira issue OPS-12",
    external: { system: "jira", key: "OPS-12", url: "https://acme.atlassian.net/browse/OPS-12", status: "In Progress", statusCategory: "indeterminate", remoteUpdatedAt: 1 },
  });

  it("shows the issue's key and status on its card, and links to it from the ticket", () => {
    render(<WorkforceView hub={hub({ workTickets: [mirrored, ticket("plain")] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    expect(screen.getByTestId("ticket-jira-t-jira-1")).toHaveTextContent("OPS-12 · In Progress");
    expect(screen.queryByTestId("ticket-jira-plain")).toBeNull();
    fireEvent.click(screen.getByText("OPS-12: Disk almost full"));
    const link = within(screen.getByTestId("ticket-jira")).getByRole("link", { name: "OPS-12" });
    expect(link).toHaveAttribute("href", "https://acme.atlassian.net/browse/OPS-12");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("says on the ticket when something could not be written to Jira", () => {
    const failed = { ...mirrored, external: { ...mirrored.external!, error: "Jira has more than one way to close OPS-12." } };
    render(<WorkforceView hub={hub({ workTickets: [failed] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    fireEvent.click(screen.getByText("OPS-12: Disk almost full"));
    expect(within(screen.getByTestId("ticket-jira")).getByRole("alert")).toHaveTextContent("Jira has more than one way to close OPS-12.");
  });
});

describe("the Jira connection on the board", () => {
  it("says in one line what the connection is doing", () => {
    expect(atlassianSummary("jira", undefined)).toBe("Jira · not connected");
    const base = { product: "jira" as const, variant: "cloud" as const, baseUrl: "https://acme.atlassian.net", hasToken: true, enabled: true };
    expect(atlassianSummary("jira", { jira: { ...base, projects: [] } })).toBe("Jira · connected, no project chosen");
    expect(atlassianSummary("jira", { jira: { ...base, projects: ["OPS", "NET"] } })).toBe("Jira · mirroring OPS, NET");
    expect(atlassianSummary("jira", { jira: { ...base, projects: ["OPS"], lastError: "The sign-in was refused" } })).toBe("Jira · could not be read: The sign-in was refused");
    expect(atlassianSummary("jira", { jira: { ...base, enabled: false } })).toBe("Jira · connected, switched off");
  });

  it("saves what is in the form before it tests it, offers the projects found, and never shows a stored token", async () => {
    const sent: HubRequest[] = [];
    const act = vi.fn(async (request: HubRequest) => {
      sent.push(request);
      return (request.action === "atlassian-test"
        ? { reply: { atlassianTest: { ok: true, account: "Ops Bot", projects: [{ key: "OPS", name: "Operations" }, { key: "NET", name: "Network" }] } } }
        : {}) as HubSnapshot;
    });
    const saved = { product: "jira" as const, variant: "cloud" as const, baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", hasToken: true, enabled: true, projects: ["OPS"], closeOnApprove: true };
    render(<WorkforceView hub={hub({ atlassian: { jira: saved } })} act={act} onOpenTask={() => {}} />);
    const card = screen.getByTestId("jira-connection");
    const token = within(card).getByLabelText(/API token/);
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", "Set. Leave empty to keep it.");

    fireEvent.click(within(card).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(within(card).getByTestId("jira-said")).toHaveTextContent("Signed in as Ops Bot. 2 projects can be seen."));
    expect(sent.map((r) => r.action)).toEqual(["atlassian-save", "atlassian-test"]);
    // No token typed: none is sent, so the stored one is kept.
    expect(sent[0]).toMatchObject({ connection: { product: "jira", baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", token: undefined, projects: ["OPS"], closeOnApprove: true } });

    fireEvent.click(within(within(card).getByTestId("jira-projects-offered")).getByRole("button", { name: "NET" }));
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toMatchObject({ connection: { projects: ["OPS", "NET"] } });
  });

  it("says the sign-in is the person's own and not shared with the team", () => {
    render(<WorkforceView hub={hub({})} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    expect(screen.getByTestId("jira-connection")).toHaveTextContent("Yours alone: it acts as your account");
    expect(screen.getByTestId("jira-connection")).toHaveTextContent("never shared with the team's workspace or bucket");
  });
});
