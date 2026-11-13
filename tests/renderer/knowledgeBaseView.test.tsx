// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot, KbDocument, KbPage } from "../../src/shared/types/aiHub";
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

  it("says that a link fetched again has changed, instead of 'nothing was added'", async () => {
    const request = vi.fn(async () => answer({ ingest: { added: [], duplicates: [], failed: [], updated: ["Vendor page"] } }));
    render(<KnowledgeBaseView hub={hub()} act={vi.fn()} onAttachDoc={() => {}} request={request} />);
    fireEvent.change(screen.getByTestId("kb-paste"), { target: { value: "https://wiki.example.internal/ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch the page" }));
    const inbox = await screen.findByTestId("kb-inbox");
    await waitFor(() => expect(within(inbox).queryByText("taking in…")).not.toBeInTheDocument());
    // The list is folded away when nothing went wrong; the line is there, inside it.
    expect(within(inbox).getByText(/has changed; its pages are being brought in line with it/)).toBeInTheDocument();
    expect(screen.getByText(/1 brought up to date/)).toBeInTheDocument();
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

const page = (id: string, extra: Partial<KbPage> = {}): KbPage => ({
  id,
  kind: "troubleshooting",
  title: `Page ${id}`,
  when: "When the backup runs long",
  body: "start of the body",
  targets: ["Backup-ZFS"],
  sources: [{ docId: "a", title: "Backup notes" }],
  revision: 2,
  createdAt: 1,
  updatedAt: Date.now(),
  updatedBy: "assistant",
  history: [{ at: Date.now(), by: "assistant", summary: "Added the quota cause", previous: { title: "", when: "", body: "", targets: [], sources: [] } }],
  ...extra,
});

describe("the pages agents read", () => {
  it("opens on the pages, shows when to open each and what it rests on, and can undo the assistant's change", async () => {
    const whole = page("p1", { body: "## Symptom\n\nThe **whole** page." });
    const request = vi.fn(async () => answer({ kbPage: whole }));
    const act = vi.fn(async () => hub());
    render(
      <KnowledgeBaseView
        hub={hub({ kbPages: [page("p1"), page("p2", { kind: "system", title: "How the pool is set up", history: [{ at: 1, by: "jacob", summary: "Written by hand" }], editedByPerson: true, sources: [] })], kbDocuments: [doc("a")] })}
        act={act}
        onAttachDoc={() => {}}
        request={request}
      />,
    );
    const card = screen.getByTestId("kb-page-p1");
    expect(within(card).getByText("When the backup runs long")).toBeVisible();
    expect(within(card).getByText(/the assistant, .*: Added the quota cause/)).toBeVisible();
    expect(within(screen.getByTestId("kb-pages-system")).getByText("hand-edited")).toBeVisible();
    // A hand-written page offers no undo of an assistant change.
    expect(within(screen.getByTestId("kb-page-p2")).queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Read" }));
    expect(await screen.findByText("whole")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "Undo the last change" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "kb-page-undo", id: "p1" }));
  });

  it("lists what to review, and turns a gap into a page to write", async () => {
    const act = vi.fn(async () => hub());
    render(
      <KnowledgeBaseView
        hub={hub({
          kbPages: [page("p1")],
          kbFindings: [
            { id: "gap:x", kind: "gap", text: "An agent looked for “rotate the ceph keys” and found nothing.", at: 2 },
            { id: "dead-target:p1:old", kind: "dead-target", pageId: "p1", text: "“Page p1” is about Old-Cluster, which the workspace no longer has.", at: 1 },
          ],
        })}
        act={act}
        onAttachDoc={() => {}}
        request={vi.fn(async () => answer({}))}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "To review · 2" }));
    const list = screen.getByTestId("kb-findings");
    expect(within(list).getByText(/Old-Cluster/)).toBeVisible();
    fireEvent.click(within(screen.getByTestId("kb-finding-dead-target")).getByRole("button", { name: "Dismiss" }));
    expect(act).toHaveBeenCalledWith({ action: "kb-finding-dismiss", id: "dead-target:p1:old" });
    fireEvent.click(within(list).getByRole("button", { name: "Write the page" }));
    const form = await screen.findByTestId("kb-page-form");
    expect(within(form).getByDisplayValue("rotate the ceph keys")).toBeVisible();
    fireEvent.change(within(form).getByLabelText(/When should an agent open this/), { target: { value: "When the ceph keys must be rotated" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "kb-page-save",
        page: expect.objectContaining({ kind: "troubleshooting", title: "rotate the ceph keys", when: "When the ceph keys must be rotated" }),
      }),
    );
  });

  it("shows what a page is not backed by, what it is also found by, and how it held up", async () => {
    const unverified = page("p1", {
      keys: ["ENOSPC", "pool is full"],
      proven: 2,
      opens: 5,
      alerts: ["DiskFull"],
      unverified: { commands: ["zpool destroy tank"], citations: ["Invented book"] },
    });
    const request = vi.fn(async () => answer({ kbPage: { ...unverified, body: "The whole body of the page." } }));
    render(
      <KnowledgeBaseView
        hub={hub({ kbPages: [unverified], kbWork: { rebuilding: [], checkingContradictions: false, rebuilt: { p1: { at: 1, changed: false } } } })}
        act={vi.fn(async () => hub())}
        onAttachDoc={() => {}}
        request={request}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Pages · 1" }));
    const card = screen.getByTestId("kb-page-p1");
    expect(within(card).getByText("unverified")).toBeVisible();
    expect(within(card).getByText("held up ×2")).toBeVisible();
    expect(within(card).getByText("alert: DiskFull")).toBeVisible();
    expect(within(card).getByText("Also found by: ENOSPC · pool is full")).toBeVisible();
    expect(within(card).getByTestId("kb-rebuilt-p1")).toHaveTextContent("already said what its sources say");
    fireEvent.click(within(card).getByRole("button", { name: "Read" }));
    const warning = await within(card).findByTestId("kb-unverified-p1");
    expect(warning).toHaveTextContent("zpool destroy tank");
    expect(warning).toHaveTextContent("Invented book");
  });

  it("lets a person say which page answers a question that found nothing", async () => {
    const act = vi.fn(async () => hub());
    render(
      <KnowledgeBaseView
        hub={hub({
          kbPages: [page("p1", { title: "Name resolution fails" })],
          kbFindings: [{ id: "gap:servfail", kind: "gap", text: "An agent looked for “SERVFAIL” and found nothing.", at: 1 }],
        })}
        act={act}
        onAttachDoc={() => {}}
        request={vi.fn(async () => answer({}))}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "To review · 1" }));
    fireEvent.click(screen.getByRole("button", { name: "A page answers this" }));
    fireEvent.change(screen.getByLabelText("The page that answers this"), { target: { value: "p1" } });
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "kb-gap-answered", id: "gap:servfail", pageId: "p1" }));
  });

  it("says when pages are being compared and how the last comparison ended, instead of 'done' at once", () => {
    const view = (kbWork: HubSnapshot["kbWork"]) => (
      <KnowledgeBaseView hub={hub({ kbPages: [page("p1"), page("p2")], kbFindings: [{ id: "gap:x", kind: "gap", text: "x", at: 1 }], kbWork })} act={vi.fn(async () => hub())} onAttachDoc={() => {}} request={vi.fn(async () => answer({}))} />
    );
    const { rerender } = render(view({ rebuilding: [], checkingContradictions: true }));
    fireEvent.click(screen.getByRole("tab", { name: "To review · 1" }));
    expect(screen.getByRole("button", { name: "Comparing pages…" })).toBeDisabled();
    expect(screen.queryByTestId("kb-last-check")).not.toBeInTheDocument();
    rerender(view({ rebuilding: [], checkingContradictions: false, lastCheck: { at: 1, found: 2, compared: 12, of: 40 } }));
    expect(screen.getByRole("button", { name: "Check for contradictions" })).toBeEnabled();
    expect(screen.getByTestId("kb-last-check")).toHaveTextContent(
      "The last comparison read 12 of 40 pairs of pages and found 2 places where they disagree.",
    );
    // Nothing found, and pairs left: the person is told that checking again goes on with the next ones.
    rerender(view({ rebuilding: [], checkingContradictions: false, lastCheck: { at: 1, found: 0, compared: 12, of: 40 } }));
    expect(screen.getByTestId("kb-last-check")).toHaveTextContent("Check again to go on with the next pairs.");
    rerender(view({ rebuilding: [], checkingContradictions: false, lastCheck: { at: 1, found: 0, error: "No model is connected" } }));
    expect(screen.getByTestId("kb-last-check")).toHaveTextContent("The last comparison did not finish: No model is connected");
  });
});
