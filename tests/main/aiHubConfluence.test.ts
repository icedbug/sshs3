import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { storageToHtml, type AtlassianRequest, type AtlassianTransport } from "../../src/main/ai/hub/Atlassian";

/** Confluence in the knowledge base: pages read in as sources, read again, and what a person removed staying removed. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

interface FakePage {
  id: string;
  title: string;
  version: number;
  storage: string;
}

function fakeConfluence() {
  const pages = new Map<string, FakePage>();
  const asked: AtlassianRequest[] = [];
  const written: { how: string; id: string; spaceId?: string; parentId?: string }[] = [];
  const put = (id: string, title: string, storage: string): FakePage => {
    const had = pages.get(id);
    const page = { id, title, storage, version: (had?.version ?? 0) + 1 };
    pages.set(id, page);
    return page;
  };
  const shape = (p: FakePage) => ({ id: p.id, title: p.title, version: { number: p.version }, body: { storage: { value: p.storage } }, _links: { webui: `/spaces/OPS/pages/${p.id}` } });
  const transport: AtlassianTransport = async (r) => {
    asked.push(r);
    const url = new URL(r.url);
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    if (url.pathname === "/wiki/api/v2/spaces") return ok({ results: url.searchParams.get("keys") === "NOPE" ? [] : [{ id: 55, key: "OPS", name: "Operations" }] });
    if (url.pathname === "/wiki/api/v2/spaces/55/pages") return ok({ results: [...pages.values()].map(shape) });
    const one = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(url.pathname);
    if (url.pathname === "/wiki/api/v2/pages" && r.method === "POST") {
      const body = JSON.parse(r.body!);
      const page = put(String(900 + pages.size), body.title, body.body.value);
      written.push({ how: "created", id: page.id, spaceId: body.spaceId, parentId: body.parentId });
      return ok(shape(page));
    }
    if (one && r.method === "GET") return pages.has(one[1]) ? ok(shape(pages.get(one[1])!)) : { status: 404, body: "{}" };
    if (one && r.method === "PUT") {
      const body = JSON.parse(r.body!);
      const had = pages.get(one[1])!;
      if (body.version.number !== had.version + 1) return { status: 409, body: JSON.stringify({ errors: [{ title: "Version conflict" }] }) };
      const page = put(one[1], body.title, body.body.value);
      written.push({ how: "updated", id: page.id });
      return ok(shape(page));
    }
    return { status: 404, body: "{}" };
  };
  return { pages, put, transport, asked, written };
}

const LONG = "This runbook explains how the nightly backup of the production database is taken and where it is kept.";

async function connected() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-confluence-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  (hub as unknown as { kbNetwork: unknown }).kbNetwork = { fetchImpl: fetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
  const wiki = fakeConfluence();
  hub.atlassian.transport = wiki.transport;
  await hub.request({ action: "atlassian-save", connection: { product: "confluence", variant: "cloud", baseUrl: "https://acme.atlassian.net/wiki", email: "ops@acme.se", token: "secret-token", enabled: true } });
  const docs = async () => ((await hub.snapshot()).kbDocuments ?? []).filter((d) => d.sourceType === "confluence");
  return { hub, wiki, docs };
}

describe("a page's storage format, made readable", () => {
  it("keeps a code block's text, drops a macro's settings, and keeps what other macros wrap", () => {
    const html = storageToHtml(
      '<p>Run:</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[pg_dump -Fc prod > /backup/prod.dump && echo "<ok>"]]></ac:plain-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>Takes an hour.</p></ac:rich-text-body></ac:structured-macro>' +
        '<p><ac:link><ri:page ri:content-title="Other" /><ac:plain-text-link-body><![CDATA[the other page]]></ac:plain-text-link-body></ac:link></p>',
    );
    expect(html).toContain('<pre><code>pg_dump -Fc prod &gt; /backup/prod.dump &amp;&amp; echo "&lt;ok&gt;"</code></pre>');
    expect(html).toContain("<p>Takes an hour.</p>");
    expect(html).toContain("the other page");
    expect(html).not.toContain("Heads up");
    expect(html).not.toContain("bash");
    expect(html).not.toMatch(/<\/?(ac|ri):/);
  });
});

describe("a Confluence space as a source of the knowledge base", () => {
  it("adds its pages as documents, with commands intact and secrets masked, and follows the space", async () => {
    const { hub, wiki, docs } = await connected();
    wiki.put("101", "Nightly backup", `<p>${LONG}</p><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[pg_dump -Fc prod_db > /backup/prod_db.dump]]></ac:plain-text-body></ac:structured-macro><p>password=Sup3rS3cretValue99</p>`);
    wiki.put("102", "Folder", "<p>short</p>");

    const result = (await hub.request({ action: "kb-ingest-confluence", spaceKey: "OPS" })).reply!.ingest!;
    expect(result.added).toEqual(["Nightly backup"]);
    const [doc] = await docs();
    expect(doc).toMatchObject({
      title: "Nightly backup",
      sourceRef: "confluence://acme.atlassian.net/101",
      external: { system: "confluence", pageId: "101", url: "https://acme.atlassian.net/wiki/spaces/OPS/pages/101", version: 1, watch: "space:OPS" },
    });
    expect(doc.content).toContain("pg_dump -Fc prod_db > /backup/prod_db.dump");
    expect(doc.content).not.toContain("Sup3rS3cretValue99");
    expect((await hub.snapshot()).atlassian?.confluence?.watched).toMatchObject([{ kind: "space", ref: "OPS", pages: 2 }]);
    await expect(hub.request({ action: "kb-ingest-confluence", spaceKey: "NOPE" })).rejects.toThrow("There is no space NOPE this account can see.");
  });

  it("revises a document when its page changed, leaves an unchanged one alone, and says when a page is gone", async () => {
    const { hub, wiki, docs } = await connected();
    wiki.put("101", "Nightly backup", `<p>${LONG}</p>`);
    wiki.put("103", "Restore", `<p>${LONG} This one is about restoring.</p>`);
    await hub.request({ action: "kb-ingest-confluence", spaceKey: "OPS" });
    const before = await docs();
    const reread = (now: number) => hub.atlassian.rereadConfluence(now);

    // Within the day nothing is asked again.
    const calls = wiki.asked.length;
    await reread(Date.now() + 3_600_000);
    expect(wiki.asked).toHaveLength(calls);

    wiki.put("101", "Nightly backup", `<p>${LONG} It now runs at 02:00 instead of 01:00.</p>`);
    wiki.pages.delete("103");
    await reread(Date.now() + 21 * 3_600_000);
    const after = await docs();
    expect(after).toHaveLength(2);
    const backup = after.find((d) => d.external?.pageId === "101")!;
    expect(backup.id).toBe(before.find((d) => d.external?.pageId === "101")!.id);
    expect(backup.content).toContain("02:00 instead of 01:00");
    expect(backup.external?.version).toBe(2);
    const restore = after.find((d) => d.external?.pageId === "103")!;
    expect(restore.sourceCheck).toMatchObject({ error: "This page is no longer in Confluence where it was read from.", failures: 1 });
    expect(restore.content).toContain("restoring");
  });

  it("does not bring back a page a person removed from the knowledge base", async () => {
    const { hub, wiki, docs } = await connected();
    wiki.put("101", "Nightly backup", `<p>${LONG}</p>`);
    await hub.request({ action: "kb-ingest-confluence", spaceKey: "OPS" });
    await hub.request({ action: "kb-delete", id: (await docs())[0].id });
    wiki.put("101", "Nightly backup", `<p>${LONG} Changed again.</p>`);
    await hub.atlassian.rereadConfluence(Date.now() + 21 * 3_600_000);
    expect((await hub.request({ action: "kb-ingest-confluence", spaceKey: "OPS" })).reply!.ingest!.added).toEqual([]);
    expect(await docs()).toEqual([]);
  });

  it("needs a connection, and a place to read from", async () => {
    const { hub } = await connected();
    await expect(hub.request({ action: "kb-ingest-confluence" })).rejects.toThrow("Give a space key, or the id of a page whose tree to add.");
    await hub.request({ action: "atlassian-disconnect", product: "confluence" });
    await expect(hub.request({ action: "kb-ingest-confluence", spaceKey: "OPS" })).rejects.toThrow("Connect Confluence first.");
  });
});

describe("a knowledge base page, published to Confluence", () => {
  const draft = { kind: "procedure" as const, title: "Renew the certificate", when: "When the certificate expires within 14 days", body: "## Steps\n\n1. Run `certbot renew`\n2. Reload nginx\n\n<script>alert(1)</script>", targets: [] };

  it("makes a page the first time and updates the same page after that, without a new revision here", async () => {
    const { hub, wiki } = await connected();
    const page = (await hub.request({ action: "kb-page-save", page: draft })).reply!.kbPage!;
    await expect(hub.request({ action: "kb-page-publish", id: page.id })).rejects.toThrow("Say which space to publish the page in.");

    const first = (await hub.request({ action: "kb-page-publish", id: page.id, spaceKey: "OPS", parentId: "42" })).reply!.kbPage!;
    expect(wiki.written).toEqual([{ how: "created", id: "900", spaceId: "55", parentId: "42" }]);
    expect(first.published).toMatchObject({ system: "confluence", pageId: "900", version: 1, revision: page.revision, url: "https://acme.atlassian.net/wiki/spaces/OPS/pages/900" });
    expect(first.revision).toBe(page.revision);
    const stored = wiki.pages.get("900")!.storage;
    expect(stored).toContain("<em>When the certificate expires within 14 days</em>");
    expect(stored).toContain("<ol><li>Run <code>certbot renew</code></li><li>Reload nginx</li></ol>");
    expect(stored).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(stored).not.toContain("<script>");

    const edited = (await hub.request({ action: "kb-page-save", page: { ...draft, id: page.id, body: `${draft.body}\n\n3. Check the expiry date` } })).reply!.kbPage!;
    expect(edited.published).toMatchObject({ pageId: "900" });
    const second = (await hub.request({ action: "kb-page-publish", id: page.id })).reply!.kbPage!;
    expect(wiki.written.map((w) => `${w.how} ${w.id}`)).toEqual(["created 900", "updated 900"]);
    expect(second.published).toMatchObject({ pageId: "900", version: 2, revision: edited.revision });
  });

  it("writes nothing when the page was changed in Confluence, or is gone there", async () => {
    const { hub, wiki } = await connected();
    const page = (await hub.request({ action: "kb-page-save", page: draft })).reply!.kbPage!;
    await hub.request({ action: "kb-page-publish", id: page.id, spaceKey: "OPS" });
    wiki.put("900", "Renew the certificate", "<p>Edited by a colleague in Confluence.</p>");
    await expect(hub.request({ action: "kb-page-publish", id: page.id })).rejects.toThrow(
      "The page was changed in Confluence since it was published from here (version 2 there, version 1 published). Nothing was written: look at it there first.",
    );
    expect(wiki.pages.get("900")!.storage).toBe("<p>Edited by a colleague in Confluence.</p>");
    wiki.pages.delete("900");
    await expect(hub.request({ action: "kb-page-publish", id: page.id })).rejects.toThrow("The page is no longer in Confluence where it was published.");
  });
});
