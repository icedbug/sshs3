import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPageOps, buildRebuildPrompt, parsePageOps, savePageByPerson, undoPageChange } from "../../src/main/ai/hub/KbCompile";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import { mayLearnUnreviewed, replacesPersonMemory } from "../../src/main/ai/hub/MemoryDistiller";
import { SelfLearningService, isOneOffCommand } from "../../src/main/ai/hub/SelfLearningService";
import type { KbPage, MemoryEntry, MemoryProposal } from "../../src/shared/types/aiHub";

/**
 * What the knowledge base and the memory say they did, and what they learn on their own. From the
 * evaluation of the knowledge base and memory with a team of three (two rounds).
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function say(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    'data: {"type":"message_delta","usage":{"output_tokens":1}}',
    "",
  ].join("\n\n");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200 },
  );
}

async function makeHub(host: Record<string, unknown> = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-kb-honest-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      ...host,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test", actorName: "Sara Nyberg" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}
async function waitFor(check: () => boolean, ms = 6000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const page = (extra: Partial<KbPage> = {}): KbPage => ({
  id: "a",
  kind: "procedure",
  title: "Production change procedure",
  when: "Before changing anything in production",
  body: [
    "1. Open a change ticket and have it approved.",
    "2. Changes go in during the window on Fridays 16:00-18:00.",
    "3. Take a backup of what you change.",
    "4. Verify, and close the ticket.",
  ].join("\n"),
  targets: [],
  sources: [{ docId: "d1", title: "Change management" }],
  revision: 2,
  createdAt: 1000,
  updatedAt: 2000,
  updatedBy: "sara",
  editedByPerson: true,
  history: [{ at: 2000, by: "sara", summary: "Edited by hand" }, { at: 1000, by: "assistant", summary: "Created from Change management" }],
  ...extra,
});
const known = { clusters: [], servers: [] };
const update = (body: string): string =>
  "```json\n" + JSON.stringify({ pages: [{ op: "update", id: "a", title: "Rewritten", when: "Other", targets: [], body, summary: "Corrected the change window" }] }) + "\n```";

describe("a page a person edited, updated from its sources on request", () => {
  it("has a statement the source contradicts corrected where it stands, and can be undone", () => {
    const corrected = page().body.replace("Fridays 16:00-18:00", "Tuesdays 21:00-23:00 (source: Change management › Window)");
    const ops = parsePageOps(update(corrected), [page()], known, { updatesOnly: true })!;
    const rebuilt = applyPageOps([page()], ops, { by: "assistant", source: { docId: "d1", title: "Change management" }, correctPersonText: true }).pages[0];
    expect(rebuilt.body).toContain("Tuesdays 21:00-23:00");
    expect(rebuilt.body).not.toContain("Fridays");
    expect(rebuilt.body).not.toContain("## Added from");
    // The person's title and the rest of their text stay; what was replaced is kept for undo.
    expect(rebuilt.title).toBe("Production change procedure");
    expect(rebuilt.body).toContain("3. Take a backup of what you change.");
    expect(undoPageChange(rebuilt, "sara").page!.body).toBe(page().body);

    // The ordinary working-in of a source never touches a person's line: it adds under a heading.
    const added = applyPageOps([page()], ops, { by: "assistant", source: { docId: "d1", title: "Change management" } }).pages[0];
    expect(added.body).toContain("Fridays 16:00-18:00");
    expect(added.body).toContain("## Added from Change management");
  });

  it("is not rewritten wholesale under the name of a correction", () => {
    const rewrite = "A different procedure altogether.\nNothing of what the person wrote is left in it.\nIt goes on for a while so that it is long enough to count as a page body.";
    const ops = parsePageOps(update(rewrite), [page()], known, { updatesOnly: true })!;
    const rebuilt = applyPageOps([page()], ops, { by: "assistant", source: { docId: "d1", title: "Change management" }, correctPersonText: true }).pages[0];
    expect(rebuilt.body.startsWith(page().body)).toBe(true);
    expect(rebuilt.body).toContain("## Added from Change management");
  });

  it("tells the model to correct in place, not to append a correction", () => {
    const prompt = buildRebuildPrompt(page(), { id: "d1", title: "Change management" }, "Window: Tuesdays 21:00-23:00.", known);
    expect(prompt).toContain("correct that statement where it stands");
  });
});

describe("saving and undoing a page by hand", () => {
  it("changes the kind when the person changes it, says so in the history, and undo brings the old kind back", () => {
    const saved = savePageByPerson(page(), { kind: "troubleshooting", title: page().title, when: page().when, body: page().body }, "sara", 3000);
    expect(saved.kind).toBe("troubleshooting");
    expect(saved.history[0].summary).toBe("Edited by hand (kind: procedure to troubleshooting)");
    expect(undoPageChange(saved, "sara").page!.kind).toBe("procedure");
    // The same kind is an ordinary edit.
    expect(savePageByPerson(page(), { kind: "procedure", title: "T", when: "W", body: "B" }, "sara").history[0].summary).toBe("Edited by hand");
  });

  it("does not delete a hand-written page when its first version is 'undone', and says what was removed otherwise", async () => {
    const hub = await makeHub();
    const mine = (await hub.request({ action: "kb-page-save", page: { kind: "system", title: "Pooler", when: "When working on the pooler", body: "pgbouncer listens on 6432." } })).reply!.kbPage!;
    await expect(hub.request({ action: "kb-page-undo", id: mine.id })).rejects.toThrow(/only its first version/);
    expect(hub.store.data.kbPages!.map((p) => p.id)).toEqual([mine.id]);

    // The kind can be changed through the request too.
    const changed = (await hub.request({ action: "kb-page-save", page: { id: mine.id, kind: "troubleshooting", title: "Pooler", when: "When working on the pooler", body: "pgbouncer listens on 6432." } })).reply!.kbPage!;
    expect(changed.kind).toBe("troubleshooting");

    // A page the assistant created is removed by undoing its creation, and the answer says so.
    hub.store.data.kbPages = [...hub.store.data.kbPages!, page({ id: "made", title: "Made by the assistant", revision: 1, editedByPerson: undefined, history: [{ at: 1, by: "assistant", summary: "Created from Change management" }] })];
    const undone = await hub.request({ action: "kb-page-undo", id: "made" });
    expect(undone.reply!.kbPageRemoved).toEqual({ id: "made", title: "Made by the assistant" });
    expect(hub.store.data.kbPages!.map((p) => p.id)).toEqual([mine.id]);

    // A page with no source document says that, not that its sources are gone.
    await expect(hub.request({ action: "kb-page-rebuild", id: mine.id })).rejects.toThrow(/rests on no source document/);
    hub.store.data.kbPages = [page({ id: "orphan" })];
    await expect(hub.request({ action: "kb-page-rebuild", id: "orphan" })).rejects.toThrow(/None of this page's sources/);
  });
});

describe("requests that name something that is not there", () => {
  it("say so instead of answering as if it was done", async () => {
    const hub = await makeHub();
    await expect(hub.request({ action: "kb-delete", id: "no-such-document" })).rejects.toThrow("Document not found");
    await expect(hub.request({ action: "kb-page-delete", id: "no-such-page" })).rejects.toThrow("Page not found");
    await expect(hub.request({ action: "memory-feedback", id: "no-such-memory", delta: 1 })).rejects.toThrow("Memory not found");
    await expect(hub.request({ action: "memory-proposal-reject", id: "no-such-proposal" })).rejects.toThrow("Proposal not found");
    // A server card is written again from the server list: "forgotten" would not be true.
    await expect(hub.request({ action: "memory-delete", id: "auto-node:web-01" })).rejects.toThrow(/cannot be forgotten/);
    await expect(hub.request({ action: "memory-delete", id: "auto-cluster:prod" })).rejects.toThrow(/cannot be forgotten/);
  });

  it("keeps the kind of a team activity entry that says it was the assistant's", async () => {
    const hub = await makeHub();
    const snap = await hub.request({ action: "activity-record", event: { actor: "", targetLabel: "web-01", kind: "ai-action", summary: "Reloaded nginx" } });
    expect(snap.activityLog!.find((e) => e.summary === "Reloaded nginx")!.kind).toBe("ai-action");
    const odd = await hub.request({ action: "activity-record", event: { actor: "", targetLabel: "web-01", kind: "made-up" as never, summary: "An odd one" } });
    expect(odd.activityLog!.find((e) => e.summary === "An odd one")!.kind).toBe("note");
  });
});

describe("who a document is by, and what an ingest says it did", () => {
  it("puts the person's name on a document they write, and an edit by somebody else leaves it", async () => {
    const hub = await makeHub();
    const snap = await hub.request({ action: "kb-save", doc: { title: "Team note", sourceType: "note", content: "The pooler listens on 6432." } });
    const doc = snap.kbDocuments!.find((d) => d.title === "Team note")!;
    expect(doc.author).toBe("Sara Nyberg");
    await hub.request({ action: "configure", config: { actorName: "Erik Holm" } });
    const edited = await hub.request({ action: "kb-save", doc: { id: doc.id, title: "Team note", sourceType: "note", content: "The pooler listens on 6432 and 6433." } });
    expect(edited.kbDocuments!.find((d) => d.id === doc.id)!.author).toBe("Sara Nyberg");
  });

  it("reads a bucket prefix into the collection and cluster asked for, with an author, and says what was added and what was left out", async () => {
    const files: Record<string, string> = {
      "runbooks/nginx.md": "# Nginx change procedure\nAlways run nginx -t before a reload.",
      "runbooks/backup.md": "# Backup retention\nLocal dumps are kept 7 days.",
      "runbooks/copy-of-nginx.md": "# Nginx change procedure\nAlways run nginx -t before a reload.",
      "runbooks/broken.md": "",
      "runbooks/diagram.png": "not text",
    };
    const provider = {
      id: "km-runbooks",
      name: "km-runbooks",
      list: async () => [
        ...Object.keys(files).map((p) => ({ name: path.posix.basename(p), path: p, isDirectory: false, size: files[p].length })),
        { name: "huge.md", path: "runbooks/huge.md", isDirectory: false, size: 900_000 },
      ],
      readFile: async (p: string) => {
        if (p.endsWith("broken.md")) throw new Error("AccessDenied");
        return Buffer.from(files[p]);
      },
    };
    const hub = await makeHub({ resolveStorageProvider: async (id: string) => (id === "km-runbooks" ? provider : undefined) });
    vi.stubGlobal("fetch", vi.fn(async () => say("not json")));
    const first = await hub.request({ action: "kb-ingest-s3", s3ProfileId: "km-runbooks", prefix: "runbooks/", collection: "Runbooks", targetCluster: "Nordvik prod" });
    expect(first.reply!.ingest).toEqual({
      added: ["nginx.md", "backup.md"],
      duplicates: ["copy-of-nginx.md"],
      updated: [],
      failed: [
        { name: "broken.md", error: "AccessDenied" },
        { name: "huge.md", error: "Larger than 200 kB." },
      ],
    });
    const docs = (hub.store.data.kbDocuments ?? []).filter((d) => d.sourceType === "s3");
    expect(docs).toHaveLength(2);
    for (const doc of docs) expect(doc).toMatchObject({ collection: "Runbooks", cluster: "Nordvik prod", author: "Sara Nyberg" });

    // Read again: nothing new is "added"; a file whose text changed is "updated" and keeps its author.
    files["runbooks/backup.md"] = "# Backup retention\nLocal dumps are kept 14 days.";
    await hub.request({ action: "configure", config: { actorName: "Erik Holm" } });
    const second = await hub.request({ action: "kb-ingest-s3", s3ProfileId: "km-runbooks", prefix: "runbooks/" });
    expect(second.reply!.ingest).toMatchObject({ added: [], updated: ["backup.md"], duplicates: ["nginx.md", "copy-of-nginx.md"] });
    expect((hub.store.data.kbDocuments ?? []).find((d) => d.title === "backup.md" || d.content.includes("14 days"))!.author).toBe("Sara Nyberg");
    // Without a collection it is named after the profile, as before.
    await expect(hub.request({ action: "kb-ingest-s3", s3ProfileId: "nope" })).rejects.toThrow(/not found/);
  });

  it("lists the objects a bucket read left out, and why", async () => {
    const failed: { name: string; error: string }[] = [];
    const kb = new KnowledgeBaseService();
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.md`, path: `p/f${i}.md`, isDirectory: false, size: 10 }));
    const docs = await kb.ingestFromStorageProvider(
      { id: "s", name: "s", list: async () => entries, readFile: async () => Buffer.from("# Text\nBody of the file.") } as never,
      "p/",
      "Docs",
      undefined,
      2,
      { failed },
    );
    expect(docs).toHaveLength(2);
    expect(failed).toEqual([{ name: "f2.md", error: "Left out: at most 2 files are read at a time." }]);
  });
});

describe("documents whose reading failed", () => {
  it("are tried again once a reading works, a bounded number of times", async () => {
    const hub = await makeHub();
    const kb = new KnowledgeBaseService();
    const failedDoc = (title: string, attempts: number) => ({
      ...kb.createDocument({ title, content: `# ${title}\nKept for seven days on db-01.` }),
      reading: { state: "failed" as const, attempts, error: 'Codex API (400): {"detail":"Unsupported parameter: temperature"}', at: 1 },
    });
    hub.store.data.kbDocuments = [failedDoc("Failed when the model was refused", 2), failedDoc("Failed every time", 4)];
    const reading = JSON.stringify({ title: "", summary: "What the document is about.", tags: ["db-01"], kind: "runbook" });
    vi.stubGlobal("fetch", vi.fn(async () => say(reading)));

    await hub.request({ action: "kb-ingest-text", text: "# A new runbook\nRestart the queue after draining the consumers.", title: "A new runbook" });
    const state = (title: string) => hub.store.data.kbDocuments!.find((d) => d.title === title)!.reading!.state;
    await waitFor(() => state("A new runbook") === "done" && state("Failed when the model was refused") === "done");
    expect(hub.store.data.kbDocuments!.find((d) => d.title === "Failed when the model was refused")!.summary).toBe("What the document is about.");
    // Four tries in all: a document that cannot be read is not tried for ever.
    expect(state("Failed every time")).toBe("failed");
  });
});

describe("what is learned without a person looking", () => {
  const memory = (extra: Partial<MemoryEntry>): MemoryEntry => ({ id: "m1", kind: "memory", scope: "workspace", title: "nginx change rule", text: "Always nginx -t.", updatedAt: 1, ...extra });
  const proposal = (extra: Partial<MemoryProposal>): MemoryProposal =>
    ({ id: "p", op: "add", kind: "memory", scope: "workspace", title: "t", text: "x", evidence: "e", sourceId: "s", sourceTitle: "s", createdAt: 1, ...extra }) as MemoryProposal;

  it("is only what a run showed or the team did, never the assistant's own answer", () => {
    expect(mayLearnUnreviewed({ id: "task:1", title: "Session", transcript: "User: how do we reload nginx?\nAssistant: Run nginx -t, then reload." })).toBe(false);
    expect(mayLearnUnreviewed({ id: "task:1", title: "Session", transcript: "Command on web-01: nginx -t → exit 0\n  output: syntax is ok" })).toBe(true);
    // A scheduled run whose commands came back empty showed nothing.
    expect(mayLearnUnreviewed({ id: "task:1", title: "Schedule", transcript: "Command on db-01: df -h /var → exit 0\nAssistant: could not be determined" })).toBe(false);
    expect(mayLearnUnreviewed({ id: "activity:9", title: "Team activity", transcript: "[2026-11-14 09:00] sara on web-01 (config-edit): reloaded nginx" })).toBe(true);
  });

  it("never takes the place of a memory a person wrote", () => {
    const mine = memory({});
    const learned = memory({ id: "m2", title: "Learned", autoLearned: true });
    expect(replacesPersonMemory(proposal({ op: "update", targetId: "m1" }), [mine, learned])).toBe(true);
    expect(replacesPersonMemory(proposal({ op: "update", targetId: "m2" }), [mine, learned])).toBe(false);
    // A new memory under a person's title would be merged into theirs.
    expect(replacesPersonMemory(proposal({ title: "Nginx change rule " }), [mine, learned])).toBe(true);
    expect(replacesPersonMemory(proposal({ title: "Something else" }), [mine, learned])).toBe(false);
    expect(replacesPersonMemory(proposal({ title: "nginx change rule", scope: "server:web-01" }), [mine, learned])).toBe(false);
  });
});

describe("skills learned from what was run", () => {
  const kb = new KnowledgeBaseService();
  const learning = new SelfLearningService(kb);
  const sedFix =
    "echo '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  /etc/nginx/sites-enabled/shop.conf' | sudo sha256sum -c - && sudo sed -i '23s/proxy_pass http:\\/\\/127.0.0.1:8081;/proxy_pass http:\\/\\/127.0.0.1:8080;/' /etc/nginx/sites-enabled/shop.conf";

  it("tells an edit made for one file at one moment from a command worth running again", () => {
    expect(isOneOffCommand(sedFix)).toBe(true);
    expect(isOneOffCommand("sudo sed -i '23d' /etc/hosts")).toBe(true);
    expect(isOneOffCommand("sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-20261114")).toBe(true);
    expect(isOneOffCommand("cat <<'EOF' | sudo tee /etc/app.conf\nport=1\nEOF")).toBe(true);
    expect(isOneOffCommand("sudo systemctl reset-failed nginx && sudo systemctl start nginx")).toBe(false);
    expect(isOneOffCommand("sudo sed -i 's/^#Port 22/Port 22/' /etc/ssh/sshd_config")).toBe(false);
    expect(isOneOffCommand("df -h /var")).toBe(false);
  });

  it("does not keep a one-off edit as the fix for a failure, proven or not", () => {
    const failure = { command: "curl -fsS https://shop.nordvik.lan/healthz", snippet: "curl: (7) Failed to connect to shop.nordvik.lan port 443: Connection refused", exitCode: 7, label: "web-01" };
    const result = learning.learnFromCommandResolution({ memories: [], failure, fixCommand: sedFix, scope: "server:web-01", proven: true });
    expect(result.learnedSkill).toBeUndefined();
    expect(result.memories).toEqual([]);
    // A command that can be run again is still learned.
    expect(learning.learnFromCommandResolution({ memories: [], failure, fixCommand: "sudo systemctl start nginx", scope: "server:web-01", proven: true }).learnedSkill).toMatchObject({ tier: "core" });
  });

  it("does not write a playbook out of one-off edits", () => {
    const task = {
      id: "t1",
      title: "The shop is down",
      status: "completed",
      verification: "verified",
      changes: [{ id: "c", kind: "command", command: sedFix, status: "completed", exitCode: 0, target: "web-01", description: "", at: 1 }],
      messages: [],
      sources: [],
    };
    const reflected = learning.reflectOnCompletedTask({ task: task as never, memories: [], infraEdges: [], servers: [] });
    expect(reflected.memories.filter((m) => m.title.startsWith("Playbook"))).toEqual([]);
  });

  it("does not offer a skill for a request it shares two everyday words with, and still offers the one that answers it", () => {
    const skill = (extra: Partial<MemoryEntry>): MemoryEntry =>
      ({ id: "s", kind: "skill", scope: "server:web-01", title: "Fixed a failure (web-01): systemd service failed", text: "x", confidence: 0.92, updatedAt: 1, ...extra }) as MemoryEntry;
    const old = skill({
      text: "When `curl -fsS https://shop.nordvik.lan/healthz` failed on web-01 with \"Connection refused\": the fix changed the proxy for the shop.",
      sourceCommand: sedFix,
    });
    // Saved before one-off edits were kept out: not offered as a command, whatever is asked.
    expect(learning.findBestLearnedCommand([old], "show when the TLS certificate for the shop expires")).toBeUndefined();
    expect(learning.findBestLearnedCommand([old], "fix the shop proxy on web-01")).toBeUndefined();

    const restart = skill({
      title: "Fixed a failure (web-01): nginx failed to start for the shop",
      text: "When nginx failed on web-01, show the status and start it again.",
      sourceCommand: "sudo systemctl reset-failed nginx && sudo systemctl start nginx",
    });
    // "show", "the", "for": shared by any request. Two of them are not a match.
    expect(learning.findBestLearnedCommand([restart], "show when the TLS certificate for the shop expires")).toBeUndefined();
    expect(learning.findBestLearnedCommand([restart], "nginx failed to start")?.command).toBe("sudo systemctl reset-failed nginx && sudo systemctl start nginx");
  });
});
