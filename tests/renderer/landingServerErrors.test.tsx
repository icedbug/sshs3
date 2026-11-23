// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingView } from "../../src/renderer/src/components/LandingView";

const snapshot = {
  tasks: [],
  workspaceServers: [{ id: "srv-1", name: "api-01", host: "10.0.0.1", port: 22, username: "root", shared: true, cluster: "prod" }],
  agents: [], sessions: [], recentChanges: [], recentActivity: [], infraEdges: [], presence: [], kbDocuments: [], kbPages: [], memories: [],
  config: { provider: "openai-codex", model: "default", enabled: true },
  preferences: {},
};

let fail: string | undefined;
const aiHubRequest = vi.fn(async (request: { action: string }) => {
  if (request.action !== "snapshot" && fail) throw new Error(`Error invoking remote method 'ai-hub:request': Error: ${fail}`);
  return snapshot;
});

beforeEach(() => {
  fail = undefined;
  aiHubRequest.mockClear();
  (window as unknown as { multissh: unknown }).multissh = { aiHubRequest };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

const renderLanding = (): void => {
  render(
    <LandingView
      recentSSH={[]}
      onConnectRecentSSH={vi.fn()}
      onConnectSFTP={vi.fn()}
      onQuickConnectSSH={vi.fn()}
      onQuickStartTerminal={vi.fn()}
      onNewTab={vi.fn()}
      onOpenProfiles={vi.fn()}
      onNewProfile={vi.fn()}
      onOpenSyncBootstrap={vi.fn()}
      onNavigateToTabBar={vi.fn()}
    />,
  );
};

const openEditor = async (): Promise<void> => {
  renderLanding();
  fireEvent.click(await screen.findByTitle("Edit cluster, node role, tags, description and local ~/.ssh"));
};

describe("the start page says when a server could not be saved, removed or added", () => {
  it("keeps the editor open with the reason when saving fails", async () => {
    await openEditor();
    fail = "The team bucket did not answer.";
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByTestId("server-action-error");
    // The reason, without the name of the app's internal channel.
    expect(error).toHaveTextContent("Not saved. The team bucket did not answer.");
    expect(error).not.toHaveTextContent("ai-hub:request");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    // The next try works: the editor closes and the message goes away.
    fail = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(screen.queryByTestId("server-action-error")).toBeNull();
  });

  it("keeps the editor open with the reason when removing fails", async () => {
    await openEditor();
    fail = "Only an administrator can remove a shared server.";
    fireEvent.click(screen.getByTestId("delete-server-btn-srv-1"));
    expect(await screen.findByTestId("server-action-error")).toHaveTextContent("Not removed. Only an administrator can remove a shared server.");
    expect(screen.getByTestId("delete-server-btn-srv-1")).toBeInTheDocument();
  });

  it("keeps the form and what was typed when adding fails", async () => {
    renderLanding();
    fireEvent.click(await screen.findByTestId("add-cluster-node-btn"));
    fireEvent.change(screen.getByPlaceholderText("e.g. k8s-worker-02"), { target: { value: "worker-9" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 10.20.2.115"), { target: { value: "10.9.9.9" } });
    fail = "A server with that name is already saved.";
    fireEvent.click(screen.getByRole("button", { name: "Save node" }));
    expect(await screen.findByTestId("add-node-error")).toHaveTextContent("Not added. A server with that name is already saved.");
    expect(screen.getByPlaceholderText("e.g. k8s-worker-02")).toHaveValue("worker-9");
    expect(screen.getByPlaceholderText("e.g. 10.20.2.115")).toHaveValue("10.9.9.9");
  });
});
