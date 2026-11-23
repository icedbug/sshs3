// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../src/renderer/src/components/ConfirmDialog";
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

const landing = (
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
  />
);

// The start page asks before it removes a server, through the app's own dialog.
const renderLanding = (): void => {
  render(<ConfirmProvider>{landing}</ConfirmProvider>);
};

const removals = (): unknown[] => aiHubRequest.mock.calls.map(([request]) => request).filter((request) => request.action === "server-delete");

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
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove node" }));
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

describe("Remove node on the start page asks before it removes a saved server", () => {
  it("one click removes nothing: it asks, names the server and says who loses it", async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId("delete-server-btn-srv-1"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent('Remove "api-01" from the workspace? It is removed for everybody who shares it. This cannot be undone.');
    expect(removals()).toEqual([]);

    // Cancel: still there, still nothing sent, and the editor is as it was.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removals()).toEqual([]);
    expect(screen.getByTestId("delete-server-btn-srv-1")).toBeInTheDocument();
  });

  it("removes the server once the question is answered with yes", async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId("delete-server-btn-srv-1"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove node" }));
    await waitFor(() => expect(removals()).toEqual([{ action: "server-delete", profileId: "srv-1" }]));
    // Done: the editor closes.
    await waitFor(() => expect(screen.queryByTestId("delete-server-btn-srv-1")).toBeNull());
  });

  it("says a server of one's own goes from one's own list only", async () => {
    snapshot.workspaceServers[0].shared = false;
    try {
      await openEditor();
      fireEvent.click(screen.getByTestId("delete-server-btn-srv-1"));
      expect(await screen.findByRole("alertdialog")).toHaveTextContent('Remove "api-01" from your saved servers? This cannot be undone.');
    } finally {
      snapshot.workspaceServers[0].shared = true;
    }
  });

  it("removes nothing where there is no dialog to ask with", async () => {
    render(landing);
    fireEvent.click(await screen.findByTitle("Edit cluster, node role, tags, description and local ~/.ssh"));
    fireEvent.click(screen.getByTestId("delete-server-btn-srv-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removals()).toEqual([]);
    expect(screen.getByTestId("delete-server-btn-srv-1")).toBeInTheDocument();
  });
});
