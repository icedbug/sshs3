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
    expect(rows[1]).toHaveTextContent("web-prod-01");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Start" }));
    expect(act).toHaveBeenCalledWith({ action: "sim-start", scenarioId: "nginx-bad-config" });
  });

  it("keeps the story hidden until it is asked for", () => {
    render(<ScenariosCard hub={hub({ scenarios })} act={vi.fn(async () => undefined)} />);
    const list = screen.getByTestId("scenario-list");
    expect(list).not.toHaveTextContent("A zone has two names.");
    const toggle = screen.getByTestId("scenario-spoiler-nginx-bad-config");
    expect(toggle).toHaveTextContent("Show what is wrong (spoiler)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("scenario-story-nginx-bad-config")).toHaveTextContent("A zone has two names.");
    expect(list).not.toHaveTextContent("The gateway was decommissioned.");
    fireEvent.click(toggle);
    expect(list).not.toHaveTextContent("A zone has two names.");
  });

  it("does not let a check for damage read as progress, and says solved only when all hold", () => {
    const base = { id: "pg-wal-full", title: "The database server's disk is filling up", startedAt: 1, target: "pg-prod-01", commands: 0, unsupported: [] };
    const checks: NonNullable<SimulationView["running"]>["checks"] = [
      { id: "room", title: "The disk has room again", why: "97% used", kind: "resolved", pass: false },
      { id: "wal", title: "No WAL was deleted by hand", why: "none removed", kind: "no-damage", pass: true },
    ];
    const view = render(<ScenariosCard hub={hub({ scenarios: [], running: { ...base, checks, passed: 1, total: 2 } })} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("scenarios")).toHaveTextContent("not solved yet · 1 of 2 checks pass");
    const items = within(screen.getByTestId("scenario-checks")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("not yet The disk has room again");
    expect(items[1]).toHaveTextContent("ok so far No WAL was deleted by hand · checks that nothing was broken on the way");
    view.unmount();
    render(<ScenariosCard hub={hub({ scenarios: [], running: { ...base, checks: checks.map((c) => ({ ...c, pass: true })), passed: 2, total: 2 } })} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("scenarios")).toHaveTextContent("· solved · 2 of 2 checks pass");
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
    expect(screen.getByTestId("scenarios")).toHaveTextContent("Scenario · The database server's disk is filling up · not solved yet · 1 of 2 checks pass");
    const checks = within(screen.getByTestId("scenario-checks")).getAllByRole("listitem");
    expect(checks[0]).toHaveTextContent("pass The disk has room again · checks that the trouble is gone");
    expect(checks[1]).toHaveTextContent("broken No WAL was deleted by hand · checks that nothing was broken on the way");
    expect(checks[1]).toHaveTextContent("2356 WAL segments were removed");
    expect(screen.getByTestId("scenario-unsupported")).toHaveTextContent("strace -p 1432");
    expect(screen.getByTestId("scenarios")).toHaveTextContent("7 commands run so far.");
    fireEvent.click(screen.getByRole("button", { name: "Open the alert's ticket" }));
    expect(open).toHaveBeenCalledWith("t-1");
    fireEvent.click(screen.getByRole("button", { name: "Start it over" }));
    expect(act).toHaveBeenCalledWith({ action: "sim-start", scenarioId: "pg-wal-full" });
  });
});
