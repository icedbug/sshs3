// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot, KbDocument } from "../../src/shared/types/aiHub";
import { KnowledgeBaseView } from "../../src/renderer/src/components/AiHub/KnowledgeBaseView";

afterEach(cleanup);

const doc = (id: string, extra: Partial<KbDocument> = {}): KbDocument => ({
  id,
  title: `Doc ${id}`,
  sourceType: "upload",
  content: "The beginning of the text",
  contentLength: 5000,
  chunks: [],
  chunkCount: 4,
  updatedAt: 1,
  ...extra,
});
const hub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({ kbDocuments: [], workspaceServers: [], config: { provider: "anthropic" }, ...extra }) as unknown as HubSnapshot;
const answer = (reply: HubSnapshot["reply"]): HubSnapshot => ({ ...hub(), reply }) as HubSnapshot;

describe("the knowledge base inbox", () => {
  it("takes in chosen files one by one and says what became of each", async () => {
    const request = vi.fn(async (r: HubRequest) => {
      if (r.action !== "kb-ingest-file") return answer({});
      if (r.name === "twice.md") return answer({ ingest: { added: [], duplicates: ["Old runbook"], failed: [] } });
      if (r.name === "scan.pdf") throw new Error("The PDF has no text in it.");
      return answer({ ingest: { added: ["Disk swap"], duplicates: [], failed: [] } });
    });
    render(<KnowledgeBaseView hub={hub()} act={vi.fn()} onAttachDoc={() => {}} request={request} />);
    const file = (name: string, text = "hello"): File => new File([text], name, { type: "text/plain" });
    fireEvent.change(screen.getByTestId("kb-file-input"), {
      target: { files: [file("disk.md"), file("twice.md"), file("scan.pdf"), file("empty.txt", "")] },
    });
    const inbox = await screen.findByTestId("kb-inbox");
    await waitFor(() => expect(within(inbox).queryByText("taking in…")).not.toBeInTheDocument());
    expect(within(inbox).getByText("added as “Disk swap”")).toBeVisible();
    expect(within(inbox).getByText('Already here as "Old runbook"')).toBeVisible();
    expect(within(inbox).getByText("The PDF has no text in it.")).toBeVisible();
    expect(within(inbox).getByText("The file is empty.")).toBeVisible();
    // The file's bytes went to the hub; the empty one was never sent.
    const sent = request.mock.calls.map((c) => c[0]).filter((r) => r.action === "kb-ingest-file");
    expect(sent.map((r) => (r as { name: string }).name)).toEqual(["disk.md", "twice.md", "scan.pdf"]);
    expect(atob((sent[0] as { dataBase64: string }).dataBase64)).toBe("hello");
  });

  it("fetches a pasted link and adds pasted text", async () => {
    const request = vi.fn(async () => answer({ ingest: { added: ["Wiki page"], duplicates: [], failed: [] } }));
    render(<KnowledgeBaseView hub={hub()} act={vi.fn()} onAttachDoc={() => {}} request={request} />);
    fireEvent.change(screen.getByTestId("kb-paste"), { target: { value: "https://wiki.example.internal/ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch the page" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: "kb-ingest-url", url: "https://wiki.example.internal/ops" }));
    fireEvent.change(screen.getByTestId("kb-paste"), { target: { value: "We restart the queue on Tuesdays.\nSee thread." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ action: "kb-ingest-text", text: "We restart the queue on Tuesdays.\nSee thread." }),
    );
  });

  it("shows what is waiting to be read, the summary once it is, and fetches the whole text to read or attach", async () => {
    const whole = doc("a", { content: "# Whole\n\nThe **entire** text.", chunks: [{ id: "a#0", text: "x" }] });
    const request = vi.fn(async (r: HubRequest) =>
      r.action === "kb-read"
        ? answer({ kbDocument: whole })
        : answer({ kbSearch: { query: "disk", byMeaning: false, hits: [{ docId: "a", title: "Doc a", collection: "General", heading: "Doc a › Steps", snippet: "zpool replace", score: 1 }] } }),
    );
    const attach = vi.fn();
    render(
      <KnowledgeBaseView
        hub={hub({
          kbDocuments: [
            doc("a", { summary: "How to swap a disk.", reading: { state: "done", at: 1 }, original: { name: "a.pdf", size: 2048 } }),
            doc("b", { reading: { state: "queued", at: 2 } }),
            doc("c", { reading: { state: "failed", at: 3, error: "no" } }),
          ],
          kbReading: { waiting: 1, failed: 1, reading: "Doc b" },
        })}
        act={vi.fn()}
        onAttachDoc={attach}
        request={request}
      />,
    );
    expect(screen.getByTestId("kb-reading")).toHaveTextContent("Reading “Doc b” · 1 to go");
    expect(screen.getByText("How to swap a disk.")).toBeVisible();
    expect(within(screen.getByTestId("kb-doc-b")).getByText("waiting to be read")).toBeVisible();
    expect(within(screen.getByTestId("kb-doc-c")).getByRole("button", { name: "Try reading again" })).toBeVisible();
    expect(within(screen.getByTestId("kb-doc-a")).getByRole("button", { name: "Original file" })).toBeVisible();

    fireEvent.click(within(screen.getByTestId("kb-doc-a")).getByRole("button", { name: "Read" }));
    expect(await screen.findByText("entire")).toBeVisible();
    fireEvent.click(within(screen.getByTestId("kb-doc-a")).getByRole("button", { name: "Attach to chat" }));
    await waitFor(() => expect(attach).toHaveBeenCalledWith(whole));

    // Typing searches the way the assistant does, and shows where each hit sits.
    fireEvent.change(screen.getByTestId("kb-hybrid-search-input"), { target: { value: "disk" } });
    const hits = await screen.findByTestId("kb-hits");
    expect(within(hits).getByText("› Steps")).toBeVisible();
    expect(within(hits).getByText("zpool replace")).toBeVisible();
  });
});
