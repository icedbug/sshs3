// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot, SimulationView } from "../../src/shared/types/aiHub";
import { ScenariosCard } from "../../src/renderer/src/components/AiHub/ScenariosCard";

afterEach(cleanup);

const scenarios: SimulationView["scenarios"] = [
  { id: "pg-wal-full", title: "The database server's disk is filling up", story: "The gateway was decommissioned.", target: "pg-prod-db01", prompt: "Find out why." },
  { id: "nginx-bad-config", title: "The web shop is down after a configuration change", story: "A zone has two names.", target: "web-prod-01", prompt: "Get it back." },
];
const hub = (simulation?: SimulationView): HubSnapshot => ({ simulation }) as unknown as HubSnapshot;

describe("the scenarios card", () => {
  it("is not there outside the demo lab", () => {
    const { container } = render(<ScenariosCard hub={hub()} act={vi.fn(async () => undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the incidents and starts the one picked", () => {
    const act = vi.fn(async () => undefined);
    render(<ScenariosCard hub={hub({ scenarios })} act={act} />);
    const card = screen.getByTestId("scenarios");
    expect(card).toHaveTextContent("Scenarios · 2 incidents to play in the demo lab");
    expect(card).toHaveTextContent("The checks below are read off the servers, not judged by a model.");
    const rows = within(screen.getByTestId("scenario-list")).getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("The web shop is down after a configuration change");
    fireEvent.click(within(rows[1]).getByRole("button"));
    expect(act).toHaveBeenCalledWith({ action: "sim-start", scenarioId: "nginx-bad-config" });
  });

  it("shows how the running one stands, what was asked for and not simulated, and leads to its ticket", () => {
    const act = vi.fn(async () => undefined);
    const open = vi.fn();
    const running: SimulationView["running"] = {
      id: "pg-wal-full",
      title: scenarios[0].title,
      startedAt: 1,
      target: "pg-prod-db01",
      ticketId: "t-1",
      checks: [
        { id: "disk", kind: "resolved", title: "The disk has room again", pass: true, why: "/var/lib/postgresql is 36% full." },
        { id: "wal-kept", kind: "no-damage", title: "No WAL was deleted by hand", pass: false, why: "2356 WAL segments were removed from pg_wal before being archived." },
      ],
      passed: 1,
      total: 2,
      commands: 7,
      unsupported: ["strace -p 1432"],
    };
    render(<ScenariosCard hub={hub({ scenarios, running })} act={act} onOpenTicket={open} />);
    expect(screen.getByTestId("scenarios")).toHaveTextContent("Scenario · The database server's disk is filling up · 1 of 2 checks pass");
    const checks = within(screen.getByTestId("scenario-checks")).getAllByRole("listitem");
    expect(checks[0]).toHaveTextContent("pass The disk has room again · The trouble is gone");
    expect(checks[1]).toHaveTextContent("not yet No WAL was deleted by hand · Nothing was broken");
    expect(checks[1]).toHaveTextContent("2356 WAL segments were removed");
    expect(screen.getByTestId("scenario-unsupported")).toHaveTextContent("strace -p 1432");
    expect(screen.getByTestId("scenarios")).toHaveTextContent("7 commands run so far.");
    fireEvent.click(screen.getByRole("button", { name: "Open the alert's ticket" }));
    expect(open).toHaveBeenCalledWith("t-1");
    fireEvent.click(screen.getByRole("button", { name: "Start it over" }));
    expect(act).toHaveBeenCalledWith({ action: "sim-start", scenarioId: "pg-wal-full" });
  });
});
