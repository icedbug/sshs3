import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EmbeddingIndex,
  LOCAL_FALLBACK_MODEL,
  cosine,
  embedTextLocal,
  fuseRanks,
  localFallbackEmbedder,
  sparseCosine,
  sparseTermVector,
} from "../../src/main/ai/hub/EmbeddingIndex";
import {
  KnowledgeBaseService,
  formatChunkContext,
  sectionsOf,
} from "../../src/main/ai/hub/KnowledgeBaseService";
import {
  applyPageOps,
  candidatePages,
  scorePageHybrid,
} from "../../src/main/ai/hub/KbCompile";
import {
  checkPageText,
  citedSourceRefs,
  citedSources,
  stillUnverified,
} from "../../src/main/ai/hub/KbCheck";
import {
  buildChunkedContradictionPrompts,
  checkDuplicateDocuments,
  checkSplitMarkdownTables,
  chunkPairsForContradictionCheck,
  findDuplicateDocument,
  freshnessThresholdDays,
  lintKnowledgeBase,
  lintPreCompile,
  pairsToCompare,
} from "../../src/main/ai/hub/KbLint";
import type { KbDocument, KbPage, KbPageUse, MemoryEntry } from "../../src/shared/types/aiHub";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const tmp = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-kbrag-"));
  dirs.push(dir);
  return dir;
};

const makePage = (id: string, extra: Partial<KbPage> = {}): KbPage => ({
  id,
  kind: "troubleshooting",
  title: `Page ${id}`,
  when: "When investigating an incident",
  body: "## Overview\nRun diagnostics first.\n\n```\nzpool status tank\n```",
  targets: [],
  sources: [{ docId: "d1", title: "Ops Manual" }],
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
  updatedBy: "assistant",
  history: [{ at: 1000, by: "assistant", summary: "Created" }],
  ...extra,
});

describe("EmbeddingIndex local deterministic fallback embedder", () => {
  it("produces deterministic normalized vectors with real morphological/subword recall", async () => {
    const embedder = localFallbackEmbedder();
    expect(embedder.model).toBe(LOCAL_FALLBACK_MODEL);
    const [v1, v2, v3] = await embedder.embed([
      "renewing expired TLS certificates with certbot",
      "certificate renewal for expired cert",
      "postgresql vacuum deadlock connection pool",
    ]);
    expect(v1.length).toBeGreaterThan(100);
    // Unit L2 norm
    const norm = Math.sqrt(v1.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    // Deterministic across calls
    expect(embedTextLocal("renewing expired TLS certificates with certbot")).toEqual(v1);
    // Related phrasing scores markedly higher than unrelated topic
    expect(cosine(v1, v2)).toBeGreaterThan(cosine(v1, v3) + 0.15);

    // Sparse cosine helper agrees
    expect(
      sparseCosine(
        sparseTermVector("MountVolume attachvolume stuck"),
        sparseTermVector("stuck attaching volume mount"),
      ),
    ).toBeGreaterThan(0.2);
  });

  it("caches local fallback vectors in EmbeddingIndex and supports weighted RRF", async () => {
    const file = path.join(await tmp(), "local-emb.json");
    const index = new EmbeddingIndex(file);
    const embedder = localFallbackEmbedder();
    const first = await index.vectorsFor(["zfs pool resilvering", "nginx reload"], embedder);
    const second = await index.vectorsFor(["zfs pool resilvering"], embedder);
    expect(second[0]).toEqual(first[0]);

    const weighted = fuseRanks([["a", "b"], ["b", "c"]], 60, [2, 1]);
    expect(weighted.get("a")!).toBeGreaterThan(weighted.get("c")!);
  });
});

describe("KnowledgeBaseService hybrid indexing, context prepending, reranker & ranking factors", () => {
  const kb = new KnowledgeBaseService();

  it("prepends heading + cluster + collection context to chunks for retrieval", () => {
    const doc = kb.createDocument({
      id: "doc-ctx",
      title: "Storage Operations",
      collection: "Storage",
      cluster: "NetApp-Prod",
      content: [
        "# Storage Operations",
        "General cluster overview and onboarding notes. ".repeat(12),
        "",
        "## Snapshot Retention",
        "Check `df -h` and free space daily. ".repeat(10),
      ].join("\n"),
    });
    const ctx = formatChunkContext(doc, "Storage Operations › Snapshot Retention", "Check `df -h`.");
    expect(ctx).toContain("Section: Storage Operations › Snapshot Retention");
    expect(ctx).toContain("Cluster: NetApp-Prod");
    expect(ctx).toContain("Collection: Storage");

    // Body snippet itself does not mention NetApp-Prod or Retention, yet prepended context matches
    const hits = kb.search([doc], { query: "NetApp-Prod snapshot retention", limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe("doc-ctx");
    expect(hits[0].heading).toContain("Snapshot Retention");
  });

  it("indexes both KbPages (title + when + keys + targets + headings) and KbDocument chunks", async () => {
    const index = new EmbeddingIndex(path.join(await tmp(), "both.json"));
    const docs: KbDocument[] = [
      kb.createDocument({
        id: "d-dns",
        title: "CoreDNS Runbook",
        collection: "Networking",
        content: "# CoreDNS\n\n## Upstream Timeouts\nInspect `/etc/resolv.conf` and restart coredns pods.",
      }),
    ];
    const pages: KbPage[] = [
      makePage("p-dns", {
        kind: "troubleshooting",
        title: "Cluster DNS Resolution",
        when: "When pods hit SERVFAIL looking up service names",
        keys: ["SERVFAIL", "CoreDNS timeout"],
        targets: ["k8s-prod"],
        body: "## Diagnosing SERVFAIL\nCheck CoreDNS pod logs.\n\n## Upstream Forwarders\nVerify upstream DNS reachability.",
      }),
    ];

    const res = await kb.searchHybrid(
      docs,
      { query: "Diagnosing SERVFAIL CoreDNS", pages, limit: 5 },
      undefined,
      index,
    );
    expect(res.retrieval).toBe("lexical");
    expect(res.usedLocalFallback).toBe(true);
    expect(res.matches.some((m) => m.pageId === "p-dns")).toBe(true);
    expect(res.matches.some((m) => m.docId === "d-dns")).toBe(true);
    const pageHit = res.matches.find((m) => m.pageId === "p-dns")!;
    expect(pageHit.heading).toContain("Diagnosing SERVFAIL");
    expect(pageHit.heading).toContain("Upstream Forwarders");
  });

  it("reranks top 30-50 fused candidates using cross-candidate proximity and coverage without OpenAI embeddings", async () => {
    const index = new EmbeddingIndex(path.join(await tmp(), "rerank.json"));
    // Create 40+ chunks so the 30-50 candidate reranker window is exercised
    const docs: KbDocument[] = Array.from({ length: 42 }, (_, i) =>
      kb.createDocument({
        id: `d-noise-${i}`,
        title: `General Note ${i}`,
        collection: "ops",
        content: `Routine maintenance checklist item ${i}. Certificate rotation is mentioned once in passing while discussing unrelated topics like printers and tickets.`,
      }),
    );
    docs.push(
      kb.createDocument({
        id: "d-target",
        title: "TLS Ingress Maintenance",
        collection: "ops",
        content:
          "Renewing expired TLS certificates requires reloading the ingress controller after updating the secret.",
      }),
    );

    const res = await kb.searchHybrid(
      docs,
      { query: "renewing expired certificates reloading ingress", limit: 3, rerankTopK: 45 },
      undefined,
      index,
    );
    expect(res.usedLocalFallback).toBe(true);
    expect(res.matches[0].docId).toBe("d-target");
    expect(res.matches[0].rerankScore).toBeGreaterThan(0);
    expect(res.matches[0].semanticScore).toBeGreaterThan(0.2);
  });

  it("factors clusterFilter, proven, rolledBack, unverified, and staleReason decay into ranking", async () => {
    const now = 500 * DAY;
    const index = new EmbeddingIndex(path.join(await tmp(), "factors.json"));
    const baseBody = "## Disk Pool Recovery\nRun `zpool status tank` and inspect faulted vdevs.";

    const provenProd = makePage("p-proven", {
      title: "Disk Pool Recovery Prod",
      targets: ["prod-zfs"],
      proven: 4,
      updatedAt: now - 5 * DAY,
      body: baseBody,
    });
    const unverifiedPage = makePage("p-unverified", {
      title: "Disk Pool Recovery Unverified",
      targets: ["prod-zfs"],
      unverified: { commands: ["zpool destroy tank"], citations: [] },
      updatedAt: now - 5 * DAY,
      body: baseBody,
    });
    const rolledBackPage = makePage("p-rolled", {
      title: "Disk Pool Recovery Rolled",
      targets: ["prod-zfs"],
      updatedAt: now - 5 * DAY,
      body: baseBody,
    });
    const otherClusterPage = makePage("p-staging", {
      title: "Disk Pool Recovery Staging",
      targets: ["staging-zfs"],
      updatedAt: now - 5 * DAY,
      body: baseBody,
    });
    const stalePage = makePage("p-stale", {
      title: "Disk Pool Recovery Stale",
      targets: ["prod-zfs"],
      updatedAt: now - 5 * DAY,
      body: baseBody,
    });

    const pageUse: Record<string, KbPageUse> = {
      "p-proven": { opens: 10, proven: 4, lastProvenAt: now - 2 * DAY },
      "p-rolled": {
        opens: 4,
        rolledBack: [{ at: now - 3 * DAY, title: "Bad disk swap" }],
      },
    };
    const staleReasons = { "p-stale": "Replaced by Ceph cluster" };

    const res = await kb.searchHybrid(
      [],
      {
        query: "Disk Pool Recovery zpool status",
        cluster: "prod-zfs",
        pages: [unverifiedPage, rolledBackPage, otherClusterPage, stalePage, provenProd],
        pageUse,
        staleReasons,
        now,
        limit: 5,
      },
      undefined,
      index,
    );

    const order = res.matches.map((m) => m.pageId);
    expect(order[0]).toBe("p-proven");
    // Unverified, rolled-back, stale, and other-cluster pages all rank below the proven matching-cluster page
    expect(order.indexOf("p-proven")).toBeLessThan(order.indexOf("p-unverified"));
    expect(order.indexOf("p-proven")).toBeLessThan(order.indexOf("p-rolled"));
    expect(order.indexOf("p-proven")).toBeLessThan(order.indexOf("p-stale"));
    expect(order.indexOf("p-proven")).toBeLessThan(order.indexOf("p-staging"));
  });

  it("rankMemories applies recency half-life modulated by lastVerifiedAt/successCount while sparing human-pinned core invariants", () => {
    const now = 400 * DAY;
    const memories: MemoryEntry[] = [
      {
        id: "m-old-unverified",
        kind: "memory",
        tier: "archival",
        scope: "workspace",
        title: "Nginx reload timeout note",
        text: "Wait 30s after nginx reload before checking metrics.",
        confidence: 0.78,
        successCount: 0,
        autoLearned: true,
        updatedAt: now - 180 * DAY,
      },
      {
        id: "m-old-verified",
        kind: "memory",
        tier: "archival",
        scope: "workspace",
        title: "Nginx reload graceful drain",
        text: "Wait 30s after nginx reload before checking metrics.",
        confidence: 0.78,
        successCount: 5,
        lastVerifiedAt: now - 3 * DAY,
        proven: true,
        autoLearned: true,
        updatedAt: now - 180 * DAY,
      },
      {
        id: "m-stale",
        kind: "memory",
        tier: "archival",
        scope: "workspace",
        title: "Nginx reload old proxy",
        text: "Wait 30s after nginx reload before checking metrics.",
        confidence: 0.85,
        staleReason: "Legacy proxy removed",
        updatedAt: now - 2 * DAY,
      },
      {
        id: "m-core-invariant",
        kind: "memory",
        tier: "core",
        scope: "workspace",
        title: "Nginx reload invariant",
        text: "Always run nginx -t before nginx reload on production.",
        confidence: 0.9,
        autoLearned: false,
        sourceTrust: "human",
        updatedAt: now - 360 * DAY,
      },
    ];

    const ranked = kb.rankMemories(memories, "nginx reload", undefined, 10, now);
    const ids = ranked.map((m) => m.id);
    // Human-pinned core invariant is spared recency decay and stays near top
    expect(ids.slice(0, 2)).toContain("m-core-invariant");
    // Recently verified / high-successCount memory beats old unverified & stale memories
    expect(ids.indexOf("m-old-verified")).toBeLessThan(ids.indexOf("m-old-unverified"));
    expect(ids.indexOf("m-old-unverified")).toBeLessThan(ids.indexOf("m-stale"));
  });
});

describe("KbCompile semantic/hybrid candidatePages scoring", () => {
  it("matches pages semantically by concept/headings/local vector while rejecting unrelated topics", () => {
    const pages: KbPage[] = [
      makePage("p-cert", {
        kind: "procedure",
        title: "TLS Ingress Renewal",
        when: "Before x509 material expires",
        keys: ["cert-manager", "x509"],
        body: "## Renewing Expired Certificates\nRun certbot renew and reload nginx.",
      }),
      makePage("p-pg", {
        kind: "troubleshooting",
        title: "Postgres Connection Exhaustion",
        when: "When pg_stat shows max_connections saturation",
        body: "## Checking Pooler\nInspect pgbouncer stats.",
      }),
    ];

    const hits = candidatePages(pages, "renewing expiring certificate on ingress", 6);
    expect(hits.map((p) => p.id)).toEqual(["p-cert"]);

    const scoreCert = scorePageHybrid(pages[0], "renewing expiring certificate on ingress");
    const scorePg = scorePageHybrid(pages[1], "renewing expiring certificate on ingress");
    expect(scoreCert.score).toBeGreaterThan(scorePg.score);
    expect(candidatePages(pages, "printer toner replacement office floor 2")).toEqual([]);
  });
});

describe("KbCheck section citation preservation & verification", () => {
  it("preserves <section> from (source: Title > Section) and verifies commands and cited sections against doc.chunks[i].heading", () => {
    const body =
      "Drain first (source: Storage Runbook > Drain Nodes), then check (source: Storage Runbook › Fake Section), and notes (learned from: Incident #12).";
    expect(citedSources(body)).toEqual(["Storage Runbook", "Incident #12"]);
    expect(citedSourceRefs(body)).toEqual([
      {
        title: "Storage Runbook",
        section: "Drain Nodes",
        raw: "Storage Runbook > Drain Nodes",
        kind: "source",
      },
      {
        title: "Storage Runbook",
        section: "Fake Section",
        raw: "Storage Runbook › Fake Section",
        kind: "source",
      },
      {
        title: "Incident #12",
        section: undefined,
        raw: "Incident #12",
        kind: "learned from",
      },
    ]);

    const chunks = sectionsOf(
      "d1",
      [
        "# Storage Runbook",
        "Cluster operational procedures and safety baselines. ".repeat(10),
        "",
        "## Drain Nodes",
        "Run `kubectl drain node-01` cleanly.",
        "Detail. ".repeat(60),
        "",
        "## Rebalance OSDs",
        "Run `ceph osd reweight 0 0.8`.",
        "Detail. ".repeat(60),
      ].join("\n"),
    );
    expect(chunks.some((c) => c.heading?.includes("Drain Nodes"))).toBe(true);

    const check = checkPageText({
      body: [
        "Drain safely (source: Storage Runbook > Drain Nodes).",
        "Missing section claim (source: Storage Runbook > Nonexistent Section).",
        "```bash",
        "kubectl drain node-01",
        "kubectl delete namespace prod",
        "```",
      ].join("\n"),
      sourceText: "Run kubectl drain node-01 cleanly. Run ceph osd reweight 0 0.8.",
      sourceTitles: ["Storage Runbook"],
      sources: [{ title: "Storage Runbook", chunks }],
    });

    expect(check).toEqual({
      commands: ["kubectl delete namespace prod"],
      citations: ["Storage Runbook › Nonexistent Section"],
    });

    // Person-edited / previously accepted section citation is kept without re-doubting,
    // while removing the bad citation clears it in stillUnverified.
    const preserved = checkPageText({
      body: "Legacy note (source: Storage Runbook > Legacy Section).\n```bash\nkubectl drain node-01\n```",
      sourceText: "Run kubectl drain node-01 cleanly.",
      sourceTitles: ["Storage Runbook"],
      sources: [{ title: "Storage Runbook", chunks }],
      previous: {
        body: "Legacy note (source: Storage Runbook > Legacy Section).",
      },
    });
    expect(preserved).toBeUndefined();

    expect(
      stillUnverified("Drain safely (source: Storage Runbook > Drain Nodes).", check),
    ).toBeUndefined();
    expect(
      stillUnverified(
        "Missing section claim (source: Storage Runbook > Nonexistent Section).",
        check,
      ),
    ).toEqual({
      commands: [],
      citations: ["Storage Runbook › Nonexistent Section"],
    });

    // applyPageOps keeps person-edited content additive and propagates section checks
    const personPage = makePage("p-person", {
      editedByPerson: true,
      body: "Person invariant line.",
      sources: [{ docId: "d1", title: "Storage Runbook" }],
    });
    const applied = applyPageOps(
      [personPage],
      [
        {
          op: "update",
          id: "p-person",
          kind: "troubleshooting",
          title: "Storage Runbook",
          when: "When draining",
          targets: [],
          keys: [],
          body: "AI note (source: Storage Runbook > Bogus Heading).\n```bash\nkubectl drain node-01\n```",
          summary: "Added section citation",
        },
      ],
      {
        by: "assistant",
        source: { docId: "d1", title: "Storage Runbook" },
        sourceText: "Run kubectl drain node-01 cleanly.",
        sources: [{ title: "Storage Runbook", chunks }],
      },
    );
    expect(applied.pages[0].body).toContain("Person invariant line.");
    expect(applied.pages[0].unverified?.citations).toEqual([
      "Storage Runbook › Bogus Heading",
    ]);
  });
});

describe("KbLint pre-compile checks, proven-aware freshness & chunked pairsToCompare", () => {
  const kb = new KnowledgeBaseService();

  it("detects duplicate and near-duplicate KbDocuments and split Markdown tables before compile", () => {
    const d1 = kb.createDocument({
      id: "d-1",
      title: "ZFS Disk Replacement",
      content:
        "When a drive in the ZFS pool reports FAULTED in zpool status, identify the device WWN, offline the faulted disk, swap the physical drive, and run zpool replace tank old new.",
    });
    const d2 = kb.createDocument({
      id: "d-2",
      title: "ZFS Disk Replacement Copy",
      content:
        "When a drive in the ZFS pool reports FAULTED in zpool status, identify the device WWN, offline the faulted disk, swap the physical drive, and run zpool replace tank old new!",
    });
    const d3: KbDocument = {
      id: "d-split",
      title: "Port Matrix",
      sourceType: "manual",
      content: "| Service | Port |\n| --- | --- |\n| ssh | 22 |\n| https | 443 |",
      chunks: [
        { id: "d-split#0", heading: "Ports", text: "| Service | Port |\n| --- | --- |\n| ssh | 22 |" },
        { id: "d-split#1", heading: "Ports (cont)", text: "| https | 443 |" },
      ],
      updatedAt: 1000,
    };

    const dupIssues = checkDuplicateDocuments([d1, d2]);
    expect(dupIssues.some((i) => i.kind === "near-duplicate-document")).toBe(true);
    expect(findDuplicateDocument(d2, [d1])?.otherDocId).toBe("d-1");

    const tableIssues = checkSplitMarkdownTables(d3);
    expect(tableIssues).toHaveLength(1);
    expect(tableIssues[0]).toMatchObject({
      kind: "split-markdown-table",
      docId: "d-split",
      chunkIndex: 0,
    });

    const combined = lintPreCompile([d1, d2, d3]);
    expect(combined.length).toBeGreaterThanOrEqual(2);
  });

  it("uses proven-aware freshness thresholds instead of a flat 180-day clock", () => {
    const now = 500 * DAY;
    const provenPage = makePage("p-proven", {
      title: "Proven Runbook",
      proven: 2,
      updatedAt: now - 210 * DAY,
      createdAt: now - 210 * DAY,
      opens: 5,
    });
    const unverifiedPage = makePage("p-unver", {
      title: "Unverified Runbook",
      unverified: { commands: ["rm -rf /tmp/x"], citations: [] },
      updatedAt: now - 110 * DAY,
      createdAt: now - 110 * DAY,
      opens: 2,
    });
    const recentlyProven = makePage("p-recent-proven", {
      title: "Recently Proven Runbook",
      proven: 1,
      lastProvenAt: now - 15 * DAY,
      updatedAt: now - 300 * DAY,
      createdAt: now - 300 * DAY,
      opens: 4,
    });

    expect(freshnessThresholdDays(provenPage)).toBe(270);
    expect(freshnessThresholdDays(unverifiedPage)).toBe(90);

    const findings = lintKnowledgeBase({
      pages: [provenPage, unverifiedPage, recentlyProven],
      docs: [{ id: "d1", title: "Ops Manual" }] as KbDocument[],
      known: [],
      gaps: [],
      now,
    });
    const staleIds = findings.filter((f) => f.kind === "stale").map((f) => f.pageId);
    expect(staleIds).toEqual(["p-unver"]);
  });

  it("chunks pairsToCompare and builds bounded contradiction prompts preserving long page sections", () => {
    const longBodyA = [
      "## Architecture",
      "Standard nodes use 64GB RAM. ".repeat(180),
      "## Backup Schedule",
      "The nightly backup runs at 01:00 UTC on Sundays.",
    ].join("\n\n");
    const longBodyB = [
      "## Architecture",
      "Standard nodes use 64GB RAM. ".repeat(180),
      "## Backup Schedule",
      "The nightly backup runs at 03:30 UTC on Wednesdays.",
    ].join("\n\n");

    const p1 = makePage("p1", { title: "Backup Policy A", targets: ["prod"], body: longBodyA });
    const p2 = makePage("p2", { title: "Backup Policy B", targets: ["prod"], body: longBodyB });
    const p3 = makePage("p3", { title: "Backup Policy C", targets: ["prod"], body: "Another short page. ".repeat(40) });

    const res = pairsToCompare([p1, p2, p3], 12, 0);
    expect(res.total).toBe(3);
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);

    const batches = chunkPairsForContradictionCheck(res.pairs, 9_000);
    expect(batches.length).toBeGreaterThan(1);

    const prompts = buildChunkedContradictionPrompts([[p1, p2]], {
      maxBatchChars: 12_000,
      maxPageChars: 2500,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain("01:00 UTC on Sundays");
    expect(prompts[0].prompt).toContain("03:30 UTC on Wednesdays");
  });
});
