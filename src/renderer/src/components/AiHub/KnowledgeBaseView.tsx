import { externalLinkProps } from "../../lib/openLink";
import { useEffect, useRef, useState } from "react";
import {
  type HubRequest,
  type HubSnapshot,
  type KbDocument,
  type KbPage,
  type KbSearchHit,
  type RunbookStep,
  type RunbookTemplate,
} from "@shared/types/aiHub";
import { hubRequest } from "../../lib/aiHub";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { ConfirmButton } from "./ConfirmButton";
import { ConfluenceSources } from "./ConfluenceSources";
import { HighlightedCode } from "./DiffViewer";
import { KbPages, KbReview } from "./KbPagesView";
import { emptyPage, type PageDraft } from "./kbPageDraft";
import { type Act } from "./panelShared";
import { decodeFileRefHref, extractFileRefs, linkFileRefs, type FileRef } from "./reportRefs";
import { RichMarkdownContent } from "./RichMarkdownContent";

interface DocDraft {
  id?: string;
  title: string;
  collection: string;
  cluster: string;
  tags: string;
  content: string;
  sourceType?: KbDocument["sourceType"];
  sourceRef?: string;
}

/** One thing that was dropped in, and what became of it. */
interface InboxItem {
  key: string;
  name: string;
  state: "reading" | "added" | "updated" | "duplicate" | "failed";
  note?: string;
}

export interface KbStarterTemplate {
  id: string;
  label: string;
  description: string;
  title: string;
  collection: string;
  kind: NonNullable<KbDocument["kind"]>;
  tags: string[];
  content: string;
}

export const KB_STARTER_TEMPLATES: KbStarterTemplate[] = [
  {
    id: "linux-incident-runbook",
    label: "Linux Incident Runbook",
    description: "Triage CPU spikes, OOM kills, disk saturation, and failed systemd units.",
    title: "Linux Incident Runbook",
    collection: "Runbooks",
    kind: "runbook",
    tags: ["linux", "incident", "triage", "systemd"],
    content: [
      "# Linux Incident Runbook",
      "",
      "## Initial Read-Only Triage",
      "1. Check failed services: `systemctl --failed`",
      "2. Inspect recent critical errors: `journalctl -p err -n 100 --no-pager`",
      "3. Check kernel OOM and I/O warnings: `dmesg -T | tail -n 80`",
      "4. Check disk space and inodes: `df -hT && df -Pi`",
      "",
      "## Key Files",
      "- `/var/log/syslog:1`",
      "- `/etc/systemd/system`",
    ].join("\n"),
  },
  {
    id: "postgres-failover-sop",
    label: "PostgreSQL Failover SOP",
    description: "Pre-flight replication checks, Patroni switchover, and split-brain prevention.",
    title: "PostgreSQL Failover SOP",
    collection: "Databases",
    kind: "runbook",
    tags: ["postgresql", "failover", "patroni", "sop"],
    content: [
      "# PostgreSQL Failover SOP",
      "",
      "## Pre-Flight Checks",
      "1. Verify primary status: `pg_isready -h pg-primary -p 5432`",
      "2. Check cluster topology: `patronictl list`",
      "3. Inspect `/etc/postgresql/16/main/postgresql.conf:1`",
      "",
      "## Failover Procedure",
      "1. Confirm fencing of the unhealthy primary before promoting a standby.",
      "2. Execute controlled switchover: `patronictl switchover`",
      "3. Verify read/write connectivity on the new primary.",
    ].join("\n"),
  },
  {
    id: "cluster-architecture-map",
    label: "Cluster Architecture Map",
    description: "Document node roles, VIPs, storage mounts, and critical dependencies.",
    title: "Cluster Architecture Map",
    collection: "Architecture",
    kind: "architecture",
    tags: ["cluster", "architecture", "topology"],
    content: [
      "# Cluster Architecture Map",
      "",
      "## Topology Overview",
      "- Edge / Ingress: `/etc/nginx/nginx.conf:1`",
      "- App tier: stateless workers connected to PostgreSQL primary + Redis",
      "- Storage tier: shared NFS/S3 backups mounted on backup nodes",
      "",
      "## Critical Dependencies",
      "- DNS / VIP health checks must pass before routing traffic.",
    ].join("\n"),
  },
];

export const STARTER_RUNBOOK_TEMPLATES: Omit<RunbookTemplate, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "Linux Service & Resource Triage",
    description: "Deterministic read-only checks followed by AI root-cause synthesis.",
    dispatchStrategy: "sequential",
    inputs: [
      {
        name: "service",
        label: "Systemd service",
        type: "string",
        required: true,
        defaultValue: "nginx",
        description: "Target systemd unit to inspect",
      },
      {
        name: "since",
        label: "Journal lookback",
        type: "enum",
        options: ["15m", "1h", "6h"],
        defaultValue: "1h",
      },
    ],
    steps: [
      {
        id: "step-status",
        title: "Check unit status",
        kind: "check",
        command: "systemctl status {{service}} --no-pager",
        expected: "Active: active (running)",
      },
      {
        id: "step-logs",
        title: "Read recent error logs",
        kind: "command",
        command: "journalctl -u {{service}} -p err --since '-{{since}}' --no-pager",
      },
      {
        id: "step-diagnose",
        title: "Synthesize root cause",
        kind: "ai_diagnose",
        prompt: "Analyze service {{service}} status and logs from the last {{since}} and propose safe remediation.",
      },
    ],
  },
];

const emptyDoc: DocDraft = { title: "", collection: "", cluster: "", tags: "", content: "" };
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_AT_ONCE = 300;

const SOURCES: Record<string, string> = {
  folder: "from a folder",
  s3: "from S3",
  url: "from a link",
  confluence: "from Confluence",
  upload: "uploaded",
  paste: "pasted",
};

/** The first lines of a text as plain words, for a card that has no summary yet. */
function excerpt(content: string): string {
  const text = content
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[`*_>]/g, "").trim())
    .filter(Boolean)
    .slice(1, 4)
    .join(" · ");
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

/** Splits a search snippet into highlighted segments using linear case-insensitive matching (ReDoS-free). */
export function highlightSearchSnippet(
  snippet: string,
  query: string,
  maxLength = 260,
): Array<{ text: string; match: boolean }> {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const rawTerms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const longTerms = rawTerms.filter((t) => t.length >= 2);
  const terms = Array.from(new Set(longTerms.length > 0 ? longTerms : rawTerms)).sort((a, b) => b.length - a.length);

  if (terms.length === 0) {
    return [{ text: normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized, match: false }];
  }

  const lowerFull = normalized.toLowerCase();
  let firstIdx = -1;
  for (const term of terms) {
    const idx = lowerFull.indexOf(term);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx;
  }

  let windowText = normalized;
  if (normalized.length > maxLength) {
    if (firstIdx > Math.floor(maxLength * 0.45)) {
      const start = Math.max(0, firstIdx - Math.floor(maxLength * 0.3));
      const slice = normalized.slice(start, start + maxLength);
      windowText = `${start > 0 ? "…" : ""}${slice}${start + maxLength < normalized.length ? "…" : ""}`;
    } else {
      windowText = `${normalized.slice(0, maxLength)}…`;
    }
  }

  const lower = windowText.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < lower.length) {
    let bestStart = -1;
    let bestLen = 0;
    for (const term of terms) {
      const idx = lower.indexOf(term, cursor);
      if (idx !== -1 && (bestStart === -1 || idx < bestStart || (idx === bestStart && term.length > bestLen))) {
        bestStart = idx;
        bestLen = term.length;
      }
    }
    if (bestStart === -1) break;
    ranges.push({ start: bestStart, end: bestStart + bestLen });
    cursor = bestStart + bestLen;
  }

  if (ranges.length === 0) return [{ text: windowText, match: false }];

  const segments: Array<{ text: string; match: boolean }> = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) segments.push({ text: windowText.slice(pos, r.start), match: false });
    segments.push({ text: windowText.slice(r.start, r.end), match: true });
    pos = r.end;
  }
  if (pos < windowText.length) segments.push({ text: windowText.slice(pos), match: false });
  return segments;
}

/** Replaces `{{varName}}` placeholders in runbook step commands/prompts with user input values. */
export function interpolateRunbookText(
  template: string,
  values: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
    const v = values[key];
    return v === undefined || v === "" ? whole : String(v);
  });
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface DroppedEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: DroppedEntry[]) => void, fail: (e: unknown) => void) => void };
}

/** The files of a drop, folders opened: a dropped folder gives its files, not nothing. */
async function filesOfDrop(data: DataTransfer): Promise<File[]> {
  const entries = Array.from(data.items ?? [])
    .map((item) => (item as unknown as { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.())
    .filter((e): e is DroppedEntry => Boolean(e));
  if (entries.length === 0) return Array.from(data.files ?? []);
  const out: File[] = [];
  const walk = async (entry: DroppedEntry, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES_AT_ONCE || depth > 6 || entry.name.startsWith(".") || entry.name === "node_modules") return;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File | undefined>((resolve) => entry.file!(resolve, () => resolve(undefined)));
      if (file) out.push(file);
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<DroppedEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  };
  for (const entry of entries) await walk(entry, 0);
  return out;
}

type StepStatus = "pending" | "active" | "done" | "skipped";

/** Interactive step-by-step executor for deterministic + AI-assisted `RunbookTemplate` workflows. */
export function RunbookExecutor({
  runbook,
  act,
  onRunStepInTerminal,
  onAskAiStep,
}: {
  runbook: RunbookTemplate;
  act: Act;
  onRunStepInTerminal?: (command: string, step: RunbookStep, runbook: RunbookTemplate) => boolean | void | Promise<boolean>;
  onAskAiStep?: (prompt: string, step: RunbookStep, runbook: RunbookTemplate) => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const initial: Record<string, string | number | boolean> = {};
    for (const field of runbook.inputs) {
      if (field.defaultValue !== undefined) initial[field.name] = field.defaultValue;
      else if (field.type === "boolean") initial[field.name] = false;
      else if (field.type === "enum" && field.options?.length) initial[field.name] = field.options[0];
      else initial[field.name] = "";
    }
    return initial;
  });
  const [stepStates, setStepStates] = useState<Record<string, StepStatus>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const missingRequired = runbook.inputs.some((f) => {
    if (!f.required) return false;
    const v = values[f.name];
    return v === undefined || String(v).trim() === "";
  });

  const markStep = (stepId: string, state: StepStatus): void => {
    setStepStates((prev) => ({ ...prev, [stepId]: state }));
  };

  const runHub = (dryRun: boolean): void => {
    setRunningAll(true);
    setStatusMsg("");
    void act({
      action: "runbook-run",
      id: runbook.id,
      inputs: values,
      dryRun,
    })
      .then((next) => {
        if (next) setStatusMsg(dryRun ? "Dry run queued." : "Runbook execution started.");
      })
      .finally(() => setRunningAll(false));
  };

  return (
    <section className="ai-card" data-testid={`runbook-executor-${runbook.id}`}>
      <div className="ai-card-head">
        <div>
          <strong>{runbook.name}</strong>
          {runbook.description && <small>{runbook.description}</small>}
        </div>
        <div className="ai-tags">
          {runbook.dispatchStrategy && <span className="ai-badge ai-badge-mode">{runbook.dispatchStrategy}</span>}
          <span className="ai-badge">{runbook.steps.length} steps</span>
        </div>
      </div>

      {runbook.steps.some((step) => /\[(?:private key )?redacted\]/i.test(`${step.command ?? ""} ${step.prompt ?? ""}`)) && (
        <p className="ai-hint" role="note" data-testid={`runbook-hidden-${runbook.id}`}>
          A password, key or token in this runbook was hidden when it was saved. A step that shows [redacted] does not run as written: the agent refuses it, and in the terminal it would type the word [redacted].
        </p>
      )}

      {runbook.inputs.length > 0 && (
        <div className="ai-form" data-testid={`runbook-inputs-${runbook.id}`}>
          <strong>Variables</strong>
          <div className="ai-form-row">
            {runbook.inputs.map((field) => {
              const val = values[field.name];
              if (field.type === "boolean") {
                return (
                  <label key={field.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      aria-label={field.label ?? field.name}
                      checked={Boolean(val)}
                      onChange={(e) => setValues((old) => ({ ...old, [field.name]: e.target.checked }))}
                    />
                    <span>{field.label ?? field.name}</span>
                  </label>
                );
              }
              if (field.type === "enum" && field.options?.length) {
                return (
                  <label key={field.name}>
                    {field.label ?? field.name}
                    {field.required ? " *" : ""}
                    <select
                      aria-label={field.label ?? field.name}
                      value={String(val ?? "")}
                      onChange={(e) => setValues((old) => ({ ...old, [field.name]: e.target.value }))}
                    >
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                    {field.description && <small>{field.description}</small>}
                  </label>
                );
              }
              return (
                <label key={field.name}>
                  {field.label ?? field.name}
                  {field.required ? " *" : ""}
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    aria-label={field.label ?? field.name}
                    required={field.required}
                    value={String(val ?? "")}
                    onChange={(e) =>
                      setValues((old) => ({
                        ...old,
                        [field.name]: field.type === "number" ? Number(e.target.value) : e.target.value,
                      }))
                    }
                  />
                  {field.description && <small>{field.description}</small>}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="ai-rows" data-testid={`runbook-steps-${runbook.id}`}>
        {runbook.steps.map((step, idx) => {
          const state = stepStates[step.id] ?? "pending";
          const resolvedCmd = step.command ? interpolateRunbookText(step.command, values) : undefined;
          const resolvedPrompt = step.prompt
            ? interpolateRunbookText(step.prompt, values)
            : resolvedCmd
              ? `Run and analyze step "${step.title ?? step.id}": ${resolvedCmd}`
              : `Assist with runbook step "${step.title ?? step.id}"`;

          return (
            <div
              key={step.id}
              className="ai-row"
              data-testid={`runbook-step-${step.id}`}
              data-step-state={state}
              style={{ alignItems: "flex-start" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ai-tags" style={{ marginBottom: 4 }}>
                  <strong>
                    {idx + 1}. {step.title || step.id}
                  </strong>
                  <span className="ai-badge">{step.kind}</span>
                  <span
                    className={`ai-badge ${
                      state === "done"
                        ? "ai-badge-success"
                        : state === "active"
                          ? "ai-badge-mode"
                          : ""
                    }`}
                  >
                    {state}
                  </span>
                </div>
                {resolvedCmd && (
                  <pre className="ai-mono" style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
                    <HighlightedCode code={resolvedCmd} lang="bash" />
                  </pre>
                )}
                {step.expected && (
                  <small className="ai-muted">Expected: {interpolateRunbookText(step.expected, values)}</small>
                )}
                {step.prompt && (
                  <p className="ai-hint" style={{ margin: "4px 0 0" }}>
                    {interpolateRunbookText(step.prompt, values)}
                  </p>
                )}
              </div>
              <div className="ai-card-actions">
                {resolvedCmd && (
                  <button
                    type="button"
                    className="ai-btn-accent"
                    data-testid={`runbook-step-terminal-${step.id}`}
                    disabled={missingRequired || !onRunStepInTerminal}
                    onClick={async () => {
                      if (onRunStepInTerminal && await onRunStepInTerminal(resolvedCmd, step, runbook) !== false) markStep(step.id, "active");
                    }}
                  >
                    Run in terminal
                  </button>
                )}
                {(step.kind === "ai_diagnose" || step.prompt || onAskAiStep) && (
                  <button
                    type="button"
                    className="ai-btn-emerald"
                    data-testid={`runbook-step-ai-${step.id}`}
                    disabled={missingRequired || !onAskAiStep}
                    onClick={() => {
                      if (!onAskAiStep) return;
                      onAskAiStep(resolvedPrompt, step, runbook);
                      markStep(step.id, "active");
                    }}
                  >
                    Run with AI
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => markStep(step.id, state === "done" ? "pending" : "done")}
                >
                  {state === "done" ? "Reset" : "Mark done"}
                </button>
                <button type="button" onClick={() => markStep(step.id, "skipped")}>
                  Skip
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {statusMsg && (
        <p className="ai-hint" role="status" data-testid={`runbook-status-${runbook.id}`}>
          {statusMsg}
        </p>
      )}

      <div className="ai-card-actions">
        <button
          type="button"
          className="ai-btn-emerald"
          data-testid={`runbook-run-all-${runbook.id}`}
          disabled={runningAll || missingRequired}
          onClick={() => runHub(false)}
        >
          {runningAll ? "Running…" : "Run all"}
        </button>
        <button
          type="button"
          data-testid={`runbook-dry-run-${runbook.id}`}
          disabled={runningAll || missingRequired}
          onClick={() => runHub(true)}
        >
          Dry run
        </button>
      </div>
    </section>
  );
}

export function KnowledgeBaseView({
  hub,
  act,
  onAttachDoc,
  onRunRunbook,
  onOpenFileRef,
  onRunStepInTerminal,
  onAskAiStep,
  openTab,
  request = hubRequest,
}: {
  hub: HubSnapshot;
  act: Act;
  onAttachDoc: (doc: KbDocument) => void;
  onRunRunbook?: (doc: KbDocument) => void;
  onOpenFileRef?: (ref: FileRef) => void;
  onRunStepInTerminal?: (command: string, step: RunbookStep, runbook: RunbookTemplate) => boolean | void | Promise<boolean>;
  onAskAiStep?: (prompt: string, step: RunbookStep, runbook: RunbookTemplate) => void;
  openTab?: { tab: "pages" | "sources" | "runbooks" | "review"; pageId?: string; seq: number };
  /** Requests whose own answer or error this view shows itself. */
  request?: (r: HubRequest) => Promise<HubSnapshot>;
}): JSX.Element {
  const [draft, setDraft] = useState<DocDraft | undefined>();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | undefined>();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; hits: KbSearchHit[]; byMeaning: boolean } | undefined>();
  const [collectionFilter, setCollectionFilter] = useState("");
  const [open, setOpen] = useState<KbDocument | undefined>();
  const [problem, setProblem] = useState("");
  const [limit, setLimit] = useState(40);
  const [tab, setTab] = useState<"pages" | "sources" | "runbooks" | "review">(
    openTab?.tab ?? ((hub.kbPages ?? []).length > 0 ? "pages" : "sources"),
  );
  const [pageDraft, setPageDraft] = useState<PageDraft | undefined>();
  const [openPage, setOpenPage] = useState<KbPage | undefined>();
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!openTab) return;
    let cancelled = false;
    setTab(openTab.tab);
    if (openTab.pageId) {
      setProblem("");
      requestRef
        .current({ action: "kb-page-read", id: openTab.pageId })
        .then((snap) => {
          if (!cancelled && snap.reply?.kbPage) setOpenPage(snap.reply.kbPage);
        })
        .catch((error) => {
          if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [openTab]);
  const [activeRunbookId, setActiveRunbookId] = useState<string>("");
  const [openedRefNotice, setOpenedRefNotice] = useState<string>("");
  // People expect "write" to make a page. It makes a source, so say so once it is saved.
  const [savedAsSource, setSavedAsSource] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const all = hub.kbDocuments ?? [];
  const runbooks = hub.runbooks ?? [];
  const collections = Array.from(new Set(all.map((d) => d.collection).filter((c): c is string => Boolean(c)))).sort();
  const clusters = Array.from(
    new Set((hub.workspaceServers ?? []).map((s) => s.cluster).filter((c): c is string => Boolean(c))),
  );
  const reading = hub.kbReading;
  const embeddings = hub.config.provider === "openai-compatible" && Boolean(hub.config.embeddingModel);
  const docs = all
    .filter((d) => !collectionFilter || d.collection === collectionFilter)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // The search the assistant uses, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(undefined);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      request({ action: "kb-search", query: q, limit: 8 })
        .then((snap) => {
          if (seq === searchSeq.current) setHits(snap.reply?.kbSearch);
        })
        .catch(() => undefined);
    }, 280);
    return () => clearTimeout(timer);
  }, [query, request]);

  const setItem = (key: string, patch: Partial<InboxItem>): void =>
    setInbox((old) => old.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const ingest = async (key: string, r: HubRequest): Promise<void> => {
    try {
      const reply = (await request(r)).reply;
      const result = reply?.ingest;
      // How it was added, where that is not what was asked (a source name another document already had).
      const notes = [...((result as { notes?: string[] } | undefined)?.notes ?? []), ...(reply?.notes ?? [])];
      if (result?.added.length) setItem(key, { state: "added", note: [result.added.join(", "), ...notes].join(" · ") });
      // The same link, fetched again with a new text: the source we have is brought up to date,
      // and the pages resting on it are brought in line with it.
      else if (result?.updated?.length)
        setItem(key, { state: "updated", note: `“${result.updated[0]}” has changed; its pages are being brought in line with it` });
      else if (result?.duplicates.length)
        setItem(key, { state: "duplicate", note: `Already here as "${result.duplicates[0]}"` });
      else setItem(key, { state: "failed", note: "Nothing was added." });
    } catch (error) {
      setItem(key, { state: "failed", note: error instanceof Error ? error.message : String(error) });
    }
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const batch = files.slice(0, MAX_FILES_AT_ONCE);
    const items: InboxItem[] = batch.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, state: "reading" }));
    setInbox((old) => [...items, ...old].slice(0, 400));
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      if (file.size > MAX_FILE_BYTES) {
        setItem(items[i].key, { state: "failed", note: "Larger than 10 MB." });
        continue;
      }
      if (file.size === 0) {
        setItem(items[i].key, { state: "failed", note: "The file is empty." });
        continue;
      }
      await ingest(items[i].key, {
        action: "kb-ingest-file",
        name: file.name,
        mime: file.type || undefined,
        dataBase64: await toBase64(file),
      });
    }
  };

  const addPasted = async (): Promise<void> => {
    const text = pasted.trim();
    if (!text) return;
    const isLink = /^https?:\/\/\S+$/i.test(text);
    const key = `${Date.now()}-paste`;
    setInbox((old) => [{ key, name: isLink ? text : `${text.split("\n")[0].slice(0, 60)}…`, state: "reading" as const }, ...old]);
    setPasted("");
    await ingest(key, isLink ? { action: "kb-ingest-url", url: text } : { action: "kb-ingest-text", text });
  };

  /** The whole document: the list only carries the beginning of each text. */
  const whole = async (doc: KbDocument): Promise<KbDocument | undefined> => {
    setProblem("");
    try {
      return (await request({ action: "kb-read", id: doc.id })).reply?.kbDocument;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const download = async (doc: KbDocument): Promise<void> => {
    setProblem("");
    try {
      const file = (await request({ action: "kb-original", id: doc.id })).reply?.download;
      if (!file) return;
      const bytes = Uint8Array.from(atob(file.dataBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const showSource = (docId: string): void => {
    const doc = all.find((d) => d.id === docId);
    setTab("sources");
    setCollectionFilter("");
    if (doc) void whole(doc).then((full) => full && setOpen(full));
  };
  const showPage = (id: string): void => {
    setTab("pages");
    setProblem("");
    request({ action: "kb-page-read", id })
      .then((snap) => setOpenPage(snap.reply?.kbPage))
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  };

  const handleOpenFileRef = (ref: FileRef): void => {
    setOpenedRefNotice(ref.raw);
    onOpenFileRef?.(ref);
  };

  const findings = hub.kbFindings ?? [];
  const busy = inbox.filter((x) => x.state === "reading").length;
  const activeRunbook = runbooks.find((r) => r.id === activeRunbookId) ?? runbooks[0];

  return (
    <div
      className={`ai-scroll ai-kb ${dragging ? "ai-kb-dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void filesOfDrop(e.dataTransfer).then(addFiles);
      }}
    >
      <header className="ai-view-head">
        <h2>Knowledge base</h2>
        <p className="ai-hint">
          What your agents know about your systems. Drop in what the team has (runbooks, vendor manuals, wiki pages,
          config files, incident notes); the assistant works it into pages on how things are set up, how to do things
          and how to troubleshoot, and keeps them up to date from finished work.
        </p>
      </header>

      <section className="ai-dropzone" data-testid="kb-dropzone" aria-label="Add material">
        <div className="ai-dropzone-main">
          <strong>Drop files or folders here</strong>
          <small>PDF, Word, web pages, Markdown, logs, config files, CSV, up to 10 MB each.</small>
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" onClick={() => picker.current?.click()}>
              Choose files
            </button>
            <button
              type="button"
              onClick={() => {
                if (draft && !draft.id && tab === "sources") {
                  setDraft(undefined);
                  return;
                }
                if (!draft || draft.id) setDraft({ ...emptyDoc });
                setTab("sources");
              }}
            >
              {draft && !draft.id && tab === "sources" ? "Close" : "Write a source note"}
            </button>
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="kb-file-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void addFiles(files);
            }}
          />
        </div>
        <form
          className="ai-dropzone-paste"
          onSubmit={(e) => {
            e.preventDefault();
            void addPasted();
          }}
        >
          <textarea
            aria-label="Paste text or a link"
            data-testid="kb-paste"
            rows={3}
            placeholder="…or paste a link to a page, or any text: a chat thread, an email, terminal output."
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="submit" disabled={!pasted.trim()}>
            {/^https?:\/\/\S+$/i.test(pasted.trim()) ? "Fetch the page" : "Add"}
          </button>
        </form>
      </section>

      {(reading?.waiting || reading?.failed || reading?.needsModel) ? (
        <p className={`ai-reading ${reading.waiting && !reading.needsModel ? "ai-reading-on" : ""}`} data-testid="kb-reading" role="status">
          {reading.needsModel && reading.waiting
            ? `${reading.waiting} document${reading.waiting === 1 ? " is" : "s are"} waiting to be read: connect a model in Settings. They are searchable already.`
            : reading.waiting
              ? `Reading ${reading.reading ? `“${reading.reading}”` : "…"} · ${reading.waiting} to go. Documents are searchable while they wait; reading gives them a title, a summary and tags.`
              : ""}
          {reading.failed ? ` ${reading.failed} could not be described (still searchable).` : ""}
        </p>
      ) : null}

      {inbox.length > 0 && (
        <details className="ai-fold ai-inbox" open={busy > 0 || inbox.some((x) => x.state === "failed")}>
          <summary>
            {busy > 0 ? `Taking in ${busy} of ${inbox.length}…` : `Taken in: ${inbox.filter((x) => x.state === "added").length} added`}
            {inbox.some((x) => x.state === "updated") ? ` · ${inbox.filter((x) => x.state === "updated").length} brought up to date` : ""}
            {inbox.some((x) => x.state === "duplicate") ? ` · ${inbox.filter((x) => x.state === "duplicate").length} already here` : ""}
            {inbox.some((x) => x.state === "failed") ? ` · ${inbox.filter((x) => x.state === "failed").length} not readable` : ""}
          </summary>
          <ul data-testid="kb-inbox">
            {inbox.map((item) => (
              <li key={item.key} className={`ai-inbox-${item.state}`}>
                <span>{item.name}</span>
                <small>
                  {item.state === "reading" ? "taking in…" : item.state === "added" ? `added${item.note && item.note !== item.name ? ` as “${item.note}”` : ""}` : item.note}
                </small>
              </li>
            ))}
          </ul>
          {busy === 0 && (
            <button type="button" className="ai-chip" onClick={() => setInbox([])}>
              Clear the list
            </button>
          )}
        </details>
      )}

      <div className="ai-filter-bar">
        <input
          type="search"
          data-testid="kb-hybrid-search-input"
          aria-label="Search the knowledge base"
          placeholder="Ask it something: what an agent would find for these words…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {hits && (
        <section className="ai-hits" data-testid="kb-hits">
          <small>
            {hits.hits.length === 0
              ? `Nothing found for “${hits.query}”. An agent would not find anything either: this is a gap.`
              : `What an agent finds for “${hits.query}”, pages first${hits.byMeaning || embeddings ? "" : " (matched by wording)"}:`}
          </small>
          {hits.hits.map((h, i) => {
            const snippetSegments = highlightSearchSnippet(h.snippet, hits.query);
            return (
              <button
                key={`${h.docId}-${i}`}
                type="button"
                className={`ai-hit ${h.pageId ? "ai-hit-page" : ""}`}
                onClick={() => (h.pageId ? showPage(h.pageId) : showSource(h.docId))}
              >
                <strong>
                  {h.pageId ? <em>page</em> : <em>source</em>} {h.title}
                  {h.heading && h.heading !== h.title ? <span> › {h.heading.replace(`${h.title} › `, "")}</span> : null}
                </strong>
                <span className="ai-hit-snippet">
                  {snippetSegments.map((seg, segIdx) =>
                    seg.match ? (
                      <mark key={segIdx} className="ai-search-mark">
                        {seg.text}
                      </mark>
                    ) : (
                      seg.text
                    ),
                  )}
                </span>
                <small className="ai-muted">
                  {h.collection || "General"} · {hits.byMeaning || embeddings ? "semantic" : "keyword"} · score{" "}
                  {Number.isFinite(h.score) ? h.score.toFixed(2) : "-"}
                </small>
              </button>
            );
          })}
        </section>
      )}

      <div className="ai-tabs ai-kb-tabs" role="tablist">
        {(
          [
            ["pages", `Pages · ${(hub.kbPages ?? []).length}`],
            ["sources", `Sources · ${all.length}`],
            ["runbooks", `Runbooks · ${runbooks.length}`],
            ["review", `To review · ${findings.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`${tab === key ? "ai-tab-on" : ""} ${key === "review" && findings.length ? "ai-tab-alert" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {openedRefNotice && (
        <p className="ai-hint" role="status" data-testid="kb-doc-ref-status">
          Opened reference: <code className="ai-mono">{openedRefNotice}</code>
        </p>
      )}
      {problem && <p className="ai-error">{problem}</p>}

      {tab === "pages" && (
        <KbPages
          hub={hub}
          act={act}
          request={request}
          draft={pageDraft}
          setDraft={setPageDraft}
          open={openPage}
          setOpen={setOpenPage}
          onOpenSource={showSource}
          onOpenFileRef={handleOpenFileRef}
          onImportMarkdown={() => picker.current?.click()}
        />
      )}
      {tab === "runbooks" && (
        <section data-testid="kb-runbooks-tab">
          <div className="ai-section-head">
            <h3>
              Executable Runbooks <span className="ai-count">{runbooks.length}</span>
            </h3>
          </div>
          <p className="ai-hint">
            Step-by-step operational workflows with typed variables. Run deterministic checks directly in the terminal
            or hand off diagnosis steps to AI.
          </p>
          {runbooks.length === 0 ? (
            <div className="ai-card" data-testid="kb-runbooks-starter">
              <strong>No executable runbooks yet</strong>
              <p className="ai-hint">Create a starter executable runbook in one click:</p>
              <div className="ai-card-actions">
                {STARTER_RUNBOOK_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    className="ai-btn-accent"
                    data-testid="kb-create-starter-runbook"
                    onClick={() => void act({ action: "runbook-save", runbook: tpl })}
                  >
                    + {tpl.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {runbooks.length > 1 && (
                <div className="ai-tags" style={{ marginBottom: 8 }}>
                  {runbooks.map((rb) => (
                    <button
                      key={rb.id}
                      type="button"
                      className={`ai-chip ${activeRunbook?.id === rb.id ? "ai-chip-on" : ""}`}
                      onClick={() => setActiveRunbookId(rb.id)}
                    >
                      {rb.name} ({rb.steps.length})
                    </button>
                  ))}
                </div>
              )}
              {activeRunbook && (
                <RunbookExecutor
                  key={activeRunbook.id}
                  runbook={activeRunbook}
                  act={act}
                  onRunStepInTerminal={onRunStepInTerminal}
                  onAskAiStep={onAskAiStep}
                />
              )}
            </>
          )}
        </section>
      )}
      {tab === "review" && (
        <KbReview
          hub={hub}
          act={act}
          onOpenPage={showPage}
          onOpenSource={showSource}
          onWritePage={(title) => {
            setTab("pages");
            setPageDraft(emptyPage("troubleshooting", title));
          }}
        />
      )}

      {tab === "sources" && (
        <>
      {savedAsSource && !draft && (
        <p className="ai-hint" role="status" data-testid="kb-saved-as-source">
          {hub.demoMode
            ? "Saved as a source. The demo lab has no model, so it is not worked into a page here."
            : "Saved as a source. The assistant works sources into pages."}{" "}
          <button
            type="button"
            onClick={() => {
              setSavedAsSource(false);
              setTab("pages");
              setPageDraft(emptyPage());
            }}
          >
            Write a page instead
          </button>
        </p>
      )}
      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="kb-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim() || !draft.content.trim()) return;
            void act({
              action: "kb-save",
              doc: {
                id: draft.id,
                title: draft.title.trim(),
                collection: draft.collection.trim() || "General",
                cluster: draft.cluster.trim() || undefined,
                tags: draft.tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                content: draft.content,
                sourceType: draft.sourceType ?? "manual",
                sourceRef: draft.sourceRef,
              },
            }).then((next) => {
              if (next) {
                setSavedAsSource(!draft.id);
                setDraft(undefined);
                setOpen(undefined);
              }
            });
          }}
        >
          <strong>{draft.id ? "Edit source" : "Write a source note"}</strong>
          <label>
            Title
            <input
              required
              autoFocus
              placeholder="Replacing a failed disk in the backup pool"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Text (Markdown)
            <textarea
              required
              rows={12}
              className="ai-mono"
              placeholder={"# When to use this\n\n## Steps\n1. …\n\nHeadings split the document into the sections search returns."}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <datalist id="ai-kb-collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <datalist id="ai-kb-clusters">
            {clusters.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="ai-form-row">
            <label>
              Collection
              <input
                list="ai-kb-collections"
                placeholder="General"
                value={draft.collection}
                onChange={(e) => setDraft({ ...draft, collection: e.target.value })}
              />
            </label>
            <label>
              Applies to cluster (optional)
              <input
                list="ai-kb-clusters"
                placeholder="Any"
                value={draft.cluster}
                onChange={(e) => setDraft({ ...draft, cluster: e.target.value })}
              />
            </label>
          </div>
          <label>
            Tags (comma-separated)
            <input
              placeholder="backup, zfs, disk"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
          </label>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              {draft.id ? "Save changes" : "Save"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!isWebBrowserMode() || hub.demoMode ? (
        <details className="ai-fold" data-testid="kb-import-folder">
          <summary>Import a folder by its path</summary>
          <form
            className="ai-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!folderPath.trim() || importing) return;
              const before = all.length;
              setImporting(true);
              setImported(undefined);
              void act({ action: "kb-ingest-folder", folderPath: folderPath.trim() })
                .then((next) => {
                  if (next) setImported((next.kbDocuments ?? []).length - before);
                })
                .finally(() => setImporting(false));
            }}
          >
            <p className="ai-hint">
              Reads the documents in a folder on this computer, up to 300 files. Importing the same folder again
              takes in what changed.
            </p>
            <div className="ai-inline-form">
              <input
                aria-label="Folder path"
                className="ai-mono"
                placeholder="~/runbooks"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
              />
              <button type="submit" disabled={importing || !folderPath.trim()}>
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
            {imported !== undefined && (
              <p className="ai-hint">
                {imported > 0
                  ? `${imported} new document${imported === 1 ? "" : "s"}.`
                  : "No new documents: nothing readable was found, or it was all here already."}
              </p>
            )}
            {hub.demoMode && (
              <button
                type="button"
                onClick={() =>
                  void act({
                    action: "kb-ingest-s3",
                    s3ProfileId: "sg-fabricpool-dc1",
                    prefix: "runbooks/",
                    cluster: "NetApp-StorageGRID-S3",
                  })
                }
              >
                Load demo runbooks from S3
              </button>
            )}
          </form>
        </details>
      ) : null}

      <ConfluenceSources hub={hub} act={act} />

      <div className="ai-section-head">
        <h3>
          Sources <span className="ai-count">{all.length}</span>
        </h3>
      </div>

      {collections.length > 1 && (
        <div className="ai-tags ai-kb-chips">
          {["", ...collections].map((c) => (
            <button
              key={c || "all"}
              type="button"
              className={`ai-chip ${collectionFilter === c ? "ai-chip-on" : ""}`}
              aria-pressed={collectionFilter === c}
              onClick={() => setCollectionFilter(c)}
            >
              {c || "All"}
            </button>
          ))}
        </div>
      )}

      {all.length === 0 && !draft && (
        <section className="ai-card" data-testid="kb-starter-templates" aria-label="Onboarding starter templates">
          <strong>Get started with 1-click starter templates</strong>
          <p className="ai-hint">
            Drop in the folder where your team keeps its runbooks, or start immediately from a template below.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 8,
              marginTop: 8,
            }}
          >
            {KB_STARTER_TEMPLATES.map((tpl) => (
              <div
                key={tpl.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--ai-line, rgba(148, 163, 184, 0.2))",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div>
                  <strong>{tpl.label}</strong>
                  <p className="ai-hint" style={{ margin: "4px 0 0" }}>
                    {tpl.description}
                  </p>
                </div>
                <button
                  type="button"
                  className="ai-btn-accent"
                  data-testid={`kb-starter-${tpl.id}`}
                  onClick={() =>
                    void act({
                      action: "kb-save",
                      doc: {
                        title: tpl.title,
                        collection: tpl.collection,
                        kind: tpl.kind,
                        tags: tpl.tags,
                        content: tpl.content,
                        sourceType: "manual",
                      },
                    })
                  }
                >
                  Use {tpl.label}
                </button>
              </div>
            ))}
            <div
              style={{
                padding: 10,
                borderRadius: 8,
                border: "1px dashed var(--ai-line-strong, rgba(148, 163, 184, 0.35))",
                display: "grid",
                gap: 6,
              }}
            >
              <div>
                <strong>Import Markdown</strong>
                <p className="ai-hint" style={{ margin: "4px 0 0" }}>
                  Choose `.md` files or runbooks from disk to index immediately.
                </p>
              </div>
              <button
                type="button"
                data-testid="kb-starter-import-markdown"
                onClick={() => picker.current?.click()}
              >
                Import Markdown
              </button>
            </div>
          </div>
        </section>
      )}

      {docs.slice(0, limit).map((doc: KbDocument) => {
        const isOpen = open?.id === doc.id;
        const state = doc.reading?.state;
        const docFindings = findings.filter((f) => f.docId === doc.id);
        const docFileRefs = isOpen ? extractFileRefs(open.content) : [];
        return (
          <article className="ai-card" key={doc.id} data-testid={`kb-doc-${doc.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{doc.title}</strong>
                <small>
                  {doc.collection || "General"}
                  {doc.cluster && doc.cluster !== doc.collection ? ` · ${doc.cluster}` : ""}
                  {doc.kind ? ` · ${doc.kind}` : ""} · {doc.chunkCount ?? 1} section{(doc.chunkCount ?? 1) === 1 ? "" : "s"}
                  {doc.pages ? ` · ${doc.pages} page${doc.pages === 1 ? "" : "s"}` : ""}
                  {SOURCES[doc.sourceType ?? ""] ? ` · ${SOURCES[doc.sourceType ?? ""]}` : ""}
                  {doc.author ? ` by ${doc.author}` : ""} · {new Date(doc.updatedAt).toLocaleDateString()}
                </small>
              </div>
              <div className="ai-tags">
                {(state === "queued" || state === "reading") && (
                  <span className="ai-badge" title="Waiting to be given a title, a summary and tags. Searchable already.">
                    {state === "reading" ? "being read" : "waiting to be read"}
                  </span>
                )}
                {state === "failed" && (
                  <span className="ai-badge ai-badge-danger" title={doc.reading?.error}>
                    not described
                  </span>
                )}
                {doc.compiled ? (
                  <span
                    className={`ai-badge ${doc.compiled.pages > 0 ? "ai-badge-success" : "ai-badge-mode"}`}
                    data-testid={`kb-doc-compile-${doc.id}`}
                    title={doc.compiled.pages > 0 ? `Compiled into ${doc.compiled.pages} page(s)` : "Compiled with 0 pages"}
                  >
                    compiled · {doc.compiled.pages}p
                  </span>
                ) : (
                  state === "done" && (
                    <span className="ai-badge" data-testid={`kb-doc-compile-${doc.id}`}>
                      not compiled
                    </span>
                  )
                )}
                {doc.sourceCheck?.error && (
                  <span className="ai-badge ai-badge-danger" title={doc.sourceCheck.error}>
                    source error
                  </span>
                )}
                {docFindings.map((f) => (
                  <span key={f.id} className="ai-badge ai-badge-mode" title={f.text}>
                    lint: {f.kind}
                  </span>
                ))}
                {(doc.tags ?? []).slice(0, 4).map((t) => (
                  <button key={t} type="button" className="ai-chip" onClick={() => setQuery(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {isOpen ? (
              <div
                className="ai-doc-body"
                onClick={(e) => {
                  const target = e.target as HTMLElement | null;
                  const anchor = target?.closest?.('a[href^="#file-"]');
                  if (!anchor) return;
                  const decoded = decodeFileRefHref(anchor.getAttribute("href") ?? undefined);
                  if (!decoded) return;
                  e.preventDefault();
                  handleOpenFileRef(decoded);
                }}
              >
                {open.summary && <p className="ai-doc-summary">{open.summary}</p>}
                <RichMarkdownContent text={linkFileRefs(open.content)} />
                {docFileRefs.length > 0 && (
                  <div className="ai-tags" data-testid={`kb-doc-refs-${doc.id}`} style={{ marginTop: 8 }}>
                    <small className="ai-muted">Refs:</small>
                    {docFileRefs.map((ref) => (
                      <button
                        key={ref.raw}
                        type="button"
                        className="ai-chip ai-mono"
                        title={ref.host ? `Open ${ref.path} on ${ref.host}` : `Open ${ref.path}`}
                        onClick={() => handleOpenFileRef(ref)}
                      >
                        {ref.raw}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="ai-doc-excerpt">{doc.summary || excerpt(doc.content)}</p>
            )}
            {doc.compiled && (
              <small className="ai-last-run">
                {doc.compiled.pages > 0
                  ? `Worked into ${doc.compiled.pages} page${doc.compiled.pages === 1 ? "" : "s"}.`
                  : "Read; led to no page."}
              </small>
            )}
            {doc.reading?.state === "done" && doc.reading.error && (
              <small className="ai-last-run">{doc.reading.error}</small>
            )}
            {doc.sourceType === "confluence" && doc.external?.url && (
              <small className="ai-last-run">
                <a {...externalLinkProps(doc.external.url)}>
                  Open in Confluence
                </a>{" "}
                · version {doc.external.version}
              </small>
            )}
            {doc.sourceType === "url" && doc.sourceRef && (
              <small className="ai-last-run ai-mono">{doc.sourceRef}</small>
            )}
            <div className="ai-card-actions">
              {onRunRunbook && (doc.kind === "runbook" || !doc.kind) && (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => void whole(doc).then((full) => full && onRunRunbook(full))}
                >
                  Follow in chat
                </button>
              )}
              <button
                type="button"
                className="ai-btn-accent"
                onClick={() => void whole(doc).then((full) => full && onAttachDoc(full))}
              >
                Attach to chat
              </button>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => (isOpen ? setOpen(undefined) : void whole(doc).then((full) => full && setOpen(full)))}
              >
                {isOpen ? "Fold" : "Read"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void whole(doc).then(
                    (full) =>
                      full &&
                      setDraft({
                        id: full.id,
                        title: full.title,
                        collection: full.collection ?? "",
                        cluster: full.cluster ?? "",
                        tags: (full.tags ?? []).join(", "),
                        content: full.content,
                        sourceType: full.sourceType,
                        sourceRef: full.sourceRef,
                      }),
                  )
                }
              >
                Edit
              </button>
              {doc.original && (
                <button type="button" title={`${doc.original.name} · ${Math.max(1, Math.round(doc.original.size / 1024))} kB`} onClick={() => void download(doc)}>
                  Original file
                </button>
              )}
              {(state === "failed" || state === "done") && (
                <button type="button" onClick={() => void act({ action: "kb-reread", id: doc.id })}>
                  {state === "failed" ? "Try reading again" : "Describe again"}
                </button>
              )}
              <span className="ai-spacer" />
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this document?"
                onConfirm={() =>
                  void act({ action: "kb-delete", id: doc.id }).then((next) => {
                    if (next && open?.id === doc.id) setOpen(undefined);
                  })
                }
              />
            </div>
          </article>
        );
      })}
      {docs.length > limit && (
        <button type="button" className="ai-more" onClick={() => setLimit(limit + 40)}>
          Show {Math.min(40, docs.length - limit)} more
        </button>
      )}
        </>
      )}
    </div>
  );
}
