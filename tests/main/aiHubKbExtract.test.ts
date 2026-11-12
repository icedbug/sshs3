import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  contentHash,
  extractText,
  fetchUrl,
  splitLongText,
  splitSections,
  titleFromName,
} from "../../src/main/ai/hub/KbExtract";

const fixture = (name: string): Promise<Buffer> => fs.readFile(path.resolve(__dirname, "../fixtures", name));

describe("taking the text out of what is dropped in", () => {
  it("reads a PDF", async () => {
    const out = await extractText({ name: "disk.pdf", data: await fixture("kb-sample.pdf") });
    expect(out.format).toBe("pdf");
    expect(out.pages).toBe(1);
    expect(out.text).toContain("Replacing a failed disk in the backup pool");
    expect(out.text).toContain("zpool replace tank old-disk new-disk");
  });

  it("reads a Word document and keeps its headings", async () => {
    const out = await extractText({ name: "failover.docx", data: await fixture("kb-sample.docx") });
    expect(out.format).toBe("docx");
    expect(out.title).toBe("Database failover procedure");
    expect(out.text).toMatch(/^# Database failover procedure/);
    expect(out.text).toContain("pg_ctl promote");
  });

  it("reads a web page as its article, without navigation and scripts", async () => {
    const html = `<!doctype html><html><head><title>Runbook: restart the queue</title><script>track()</script></head><body>
      <nav><a href="/home">Home</a><a href="/all">All pages</a></nav>
      <article><h1>Restart the queue</h1><p>${"Drain the consumers first, then restart the broker. ".repeat(8)}</p>
      <pre><code>systemctl restart rabbitmq-server</code></pre><p>See <a href="/wiki/drain">draining</a>.</p></article>
      <footer>Copyright</footer></body></html>`;
    const out = await extractText({ name: "page.html", data: Buffer.from(html) });
    expect(out.format).toBe("html");
    expect(out.title).toMatch(/restart the queue/i);
    expect(out.text).toContain("systemctl restart rabbitmq-server");
    expect(out.text).not.toContain("track()");
    expect(out.text).not.toContain("All pages");
  });

  it("reads any text file, with or without a known extension, and says why it cannot read the rest", async () => {
    expect((await extractText({ name: "sshd_config", data: Buffer.from("PermitRootLogin no\n") })).text).toBe("PermitRootLogin no");
    await expect(extractText({ name: "a.bin", data: Buffer.from([0, 1, 2, 0, 0, 3, 0, 0]) })).rejects.toThrow(/not text/);
    await expect(extractText({ name: "shot.png", mime: "image/png", data: Buffer.from("x") })).rejects.toThrow(/Pictures cannot be read/);
    await expect(extractText({ name: "old.doc", data: Buffer.from("x") })).rejects.toThrow(/\.docx or PDF/);
    await expect(extractText({ name: "empty.md", data: Buffer.alloc(0) })).rejects.toThrow(/empty/);
  });

  it("fetches a link, makes its links absolute, and explains a page that needs a login", async () => {
    const page = `<html><head><title>Wiki: backups</title></head><body><article><h1>Backups</h1><p>${"Backups run nightly from the replica. ".repeat(6)}</p><p><a href="/wiki/restore">Restore</a></p></article></body></html>`;
    const ok = vi.fn(async () => new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const out = await fetchUrl("https://wiki.example.internal/ops/backups", ok as unknown as typeof fetch);
    expect(out.title).toMatch(/backups/i);
    expect(out.text).toContain("https://wiki.example.internal/wiki/restore");
    const denied = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(fetchUrl("https://wiki.example.internal/x", denied as unknown as typeof fetch)).rejects.toThrow(/needs a login/);
    await expect(fetchUrl("file:///etc/passwd")).rejects.toThrow(/Only http and https/);
    await expect(fetchUrl("not a link")).rejects.toThrow(/not a link/);
  });
});

describe("cutting a document into the pieces search returns", () => {
  it("leaves a short document as one piece, unchanged", () => {
    expect(splitSections("Just a note.\n\nTwo lines.")).toEqual([{ text: "Just a note.\n\nTwo lines.", heading: undefined }]);
  });

  it("follows the headings, tells each piece where it sits, and never cuts a code block or a table", () => {
    const code = ["```bash", ...Array.from({ length: 40 }, (_, i) => `echo step ${i} && systemctl status service-${i}`), "```"].join("\n");
    const table = ["| Node | Role |", "| --- | --- |", ...Array.from({ length: 30 }, (_, i) => `| node-${i} | worker |`)].join("\n");
    const doc = [
      "# Storage handbook",
      "Intro paragraph. ".repeat(30),
      "## Latency",
      "### Diagnose",
      "First look at the volume. ".repeat(20),
      code,
      "## Nodes",
      table,
      "## Empty heading at the end",
    ].join("\n\n");
    const pieces = splitSections(doc);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.some((p) => p.heading === "Storage handbook › Latency › Diagnose")).toBe(true);
    const withCode = pieces.filter((p) => p.text.includes("```"));
    for (const p of withCode) expect((p.text.match(/```/g) ?? []).length % 2).toBe(0);
    expect(pieces.filter((p) => p.text.includes("| node-0 |"))).toHaveLength(1);
    expect(pieces.find((p) => p.text.includes("| node-0 |"))!.text).toContain("| node-29 |");
    // Nothing is lost: every line of the document is in some piece.
    const all = pieces.map((p) => p.text).join("\n");
    for (const line of doc.split("\n").filter((l) => l.trim())) expect(all).toContain(line.trim().slice(0, 60));
  });

  it("cuts one enormous block by lines instead of in the middle of one", () => {
    const log = Array.from({ length: 400 }, (_, i) => `2026-11-12T10:00:${String(i % 60).padStart(2, "0")} worker-${i} finished job`).join("\n");
    const pieces = splitSections(log);
    expect(pieces.length).toBeGreaterThan(5);
    for (const p of pieces) for (const line of p.text.split("\n")) expect(line).toMatch(/finished job$/);
  });
});

describe("small helpers", () => {
  it("names a document after its file, and recognises the same text however it is wrapped", () => {
    expect(titleFromName("/tmp/ceph_runbook-v2.pdf")).toBe("ceph runbook-v2");
    expect(contentHash("Hello   World\n")).toBe(contentHash("hello world"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
  it("splits a text too long for one document where a paragraph ends", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(40)}`).join("\n\n");
    const parts = splitLongText(text, 3000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 3000 && p.startsWith("Paragraph"))).toBe(true);
    expect(parts.join("\n\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });
});
