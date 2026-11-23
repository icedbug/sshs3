// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";

let fixture: HubSnapshot;
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: (...args: unknown[]) => request(...args),
  onAiHubDelta: vi.fn(() => () => {}),
}));
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";

const base = (extra: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { enabled: true, provider: "openai-compatible", model: "local", useHermes: false, hasApiKey: false, baseUrl: "http://localhost:11434/v1" },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [], tasks: [], inventory: [], memories: [], schedules: [], infraEdges: [], workTickets: [],
    ...extra,
  }) as unknown as HubSnapshot;

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async () => fixture);
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

function Harness({ start = "hub" }: { start?: "panel" | "hub" }): JSX.Element {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">(start);
  return <AiHubPanel mode={mode} setMode={setMode} />;
}

const composer = async (): Promise<HTMLTextAreaElement> => (await screen.findByTestId("ai-composer")) as HTMLTextAreaElement;

describe("buttons that start a question in the chat leave it in the composer", () => {
  const servers = [{ id: "s1", name: "web-01", host: "10.0.0.1", port: 22, username: "ops", shared: true }];

  it("Infrastructure 'Ask about it': the question and the server's context", async () => {
    fixture = base({ workspaceServers: servers });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Infrastructure/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask about it" }, { timeout: 5000 }));
    expect((await composer()).value).toContain("Give me a short status of web-01");
    expect(screen.getByTitle("Remove @web-01")).toBeInTheDocument();
  });

  it("Infrastructure 'Investigate' on a server that does not answer", async () => {
    fixture = base({
      workspaceServers: servers,
      inventory: [{ id: "s1", kind: "ssh", label: "web-01", address: "10.0.0.1:22", status: "unreachable", detail: "timed out", observedAt: 1 }],
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Infrastructure/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Investigate" }, { timeout: 5000 }));
    expect((await composer()).value).toContain("web-01 does not answer (timed out)");
    expect(screen.getByTitle("Remove @web-01")).toBeInTheDocument();
  });

  it("Infrastructure 'Attach this output to chat': the terminal's output", async () => {
    fixture = base({
      sessions: [{ id: "term-1", generation: "g1", label: "web-01 shell", kind: "ssh", state: "ready" }],
      preview: { id: "p", sessionId: "term-1", label: "Output of web-01 shell", text: "disk /var 97% full", observedAt: 1 },
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Infrastructure/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Attach this output to chat" }, { timeout: 5000 }));
    await composer();
    expect(screen.getByTitle("Remove Output of web-01 shell")).toBeInTheDocument();
  });

  it("Knowledge base 'Follow in chat': the instruction and the runbook", async () => {
    const doc = { id: "d1", title: "Restart nginx", collection: "Web", kind: "runbook", content: "1. Check the config\n2. Reload", updatedAt: 1 };
    fixture = base({ kbDocuments: [doc] });
    // The whole document is read before it is attached.
    request.mockImplementation(async (r: { action: string }) => (r.action === "kb-read" ? { ...fixture, reply: { kbDocument: doc } } : fixture));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^(Knowledge Base|Runbooks)/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Sources/ }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Follow in chat" }));
    await waitFor(async () => expect((await composer()).value).toContain('Follow our runbook "Restart nginx"'));
    expect(screen.getByTitle("Remove @kb:restart-nginx")).toBeInTheDocument();
  });
});

describe("a message sent past the secret warning", () => {
  const secret = "the deploy fails with password=hunter2hunter2 in the log, why";
  const cloud = (): HubSnapshot =>
    base({ config: { enabled: true, provider: "openai-compatible", model: "gpt", useHermes: false, hasApiKey: true, baseUrl: "https://api.example.com/v1" } });

  const warn = async (): Promise<HTMLTextAreaElement> => {
    fixture = cloud();
    request.mockRejectedValue(new Error("The connection to the server was lost"));
    render(<Harness start="panel" />);
    const field = await composer();
    fireEvent.change(field, { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByTestId("ai-dlp-warning");
    return field;
  };

  it("'Send Anyway': the text is back in the composer when it did not go", async () => {
    const field = await warn();
    fireEvent.click(screen.getByRole("button", { name: "Send Anyway" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    await waitFor(() => expect(field.value).toBe(secret));
    expect(screen.getByText(/connection to the server was lost/)).toBeInTheDocument();
  });

  it("'Mask & Send': the person's own text is back, not the masked copy", async () => {
    const field = await warn();
    fireEvent.click(within(screen.getByTestId("ai-dlp-warning")).getByRole("button", { name: /Mask & Send/ }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    // What was sent had the secret masked.
    expect(JSON.stringify(request.mock.calls[0][0])).not.toContain("hunter2hunter2");
    await waitFor(() => expect(field.value).toBe(secret));
  });

  it("empties the composer when the message did go", async () => {
    fixture = cloud();
    request.mockImplementation(async () => ({ ...fixture, reply: { started: { taskId: "t-new" } } }));
    render(<Harness start="panel" />);
    const field = await composer();
    fireEvent.change(field, { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByTestId("ai-dlp-warning");
    fireEvent.click(screen.getByRole("button", { name: "Send Anyway" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("ai-dlp-warning")).toBeNull());
    expect(field.value).toBe("");
  });
});
