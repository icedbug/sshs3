// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { ErrorBoundary, isChunkLoadError } from "../../src/renderer/src/components/ErrorBoundary";
import { InfrastructureView } from "../../src/renderer/src/components/AiHub/InfrastructureView";
import { OtherViews } from "../../src/renderer/src/components/AiHub/panel/OtherViews";
import type { PanelState } from "../../src/renderer/src/components/AiHub/panel/usePanelState";

vi.mock("../../src/renderer/src/components/AiHub/SchedulesView", () => ({
  Schedules: () => {
    throw new Error("a view that cannot be drawn");
  },
}));
vi.mock("../../src/renderer/src/components/AiHub/MemoryView", () => ({
  Memory: () => <p>memory view</p>,
}));

beforeEach(() => {
  // React reports every caught error on the console: expected here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let broken = true;
function Flaky(): JSX.Element {
  if (broken) throw new Error("cannot draw");
  return <p>drawn</p>;
}

describe("ErrorBoundary", () => {
  it("replaces only the part that failed, with a plain message and two ways on", () => {
    broken = true;
    render(
      <div>
        <p>the rest of the app</p>
        <ErrorBoundary what="This view">
          <Flaky />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("the rest of the app")).toBeInTheDocument();
    const box = screen.getByRole("alert");
    expect(box).toHaveTextContent("This view could not be shown.");
    expect(box).toHaveTextContent("Something went wrong in this part. The rest of the app still works.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("drawn")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws the part again when another view or conversation is chosen", () => {
    broken = true;
    const view = render(
      <ErrorBoundary what="This view" resetKey="Schedules">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken = false;
    view.rerender(
      <ErrorBoundary what="This view" resetKey="Inbox">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("drawn")).toBeInTheDocument();
  });

  it("offers Reload, and only Reload, when the app's own files could not be loaded", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, configurable: true });
    // What a browser says when a page left open over an update asks for a file that is gone.
    const Gone = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/App-1a2b.js")));
    render(
      <ErrorBoundary what="The app" layout="window">
        <Suspense fallback={<p>Opening workspace…</p>}>
          <Gone />
        </Suspense>
      </ErrorBoundary>,
    );
    const box = await screen.findByRole("alert");
    expect(box).toHaveTextContent("The app could not be shown.");
    expect(box).toHaveTextContent("A newer version of sshs3 was probably installed while this page was open. Reload to get it.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the whole window offers Reload only", () => {
    broken = true;
    render(
      <ErrorBoundary what="The app" layout="window">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Reload to start again.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("knows a missing file of the app from another error", () => {
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'label')"))).toBe(false);
  });
});

describe("the hub's views", () => {
  const panel = (activeView: string): PanelState => ({ activeView, act: vi.fn(), chooseTask: vi.fn(), setView: vi.fn() }) as unknown as PanelState;
  const hub = { tasks: [], sessions: [], schedules: [], memories: [] } as unknown as NonNullable<PanelState["hub"]>;

  it("a view that fails to draw shows the message, and another view works after it", async () => {
    const view = render(<OtherViews p={panel("Schedules")} hub={hub} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This view could not be shown.");
    view.rerender(<OtherViews p={panel("Memory & skills")} hub={hub} />);
    expect(await screen.findByText("memory view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a value this version does not know", () => {
  it("a server state from a newer app is shown by its name, and the view is still drawn", () => {
    const hub = {
      config: { enabled: true },
      sessions: [],
      tasks: [],
      workspaceServers: [{ id: "s1", name: "web-01", host: "10.0.0.1", port: 22, username: "root", shared: true }],
      inventory: [{ id: "s1", kind: "ssh", label: "web-01", address: "10.0.0.1:22", status: "draining", detail: "", observedAt: 1 }],
      infraEdges: [],
    } as unknown as HubSnapshot;
    render(<InfrastructureView hub={hub} act={vi.fn()} busy={false} onUseTerminal={vi.fn()} onOpenTerminal={vi.fn()} onAsk={vi.fn()} />);
    expect(screen.getByTestId("infra-status-s1")).toHaveTextContent("draining");
  });
});
