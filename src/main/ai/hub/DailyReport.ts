import type {
  AgentSchedule,
  AgentTask,
  KbFinding,
  KbPage,
  MemoryEntry,
  WorkTicket,
  WorkspaceActivityEvent,
} from "../../../shared/types/aiHub";
import { isPlainCommand } from "../../../shared/types/aiHub";
import { clip } from "./privacy";

export interface ScheduleRunSummary {
  scheduleId: string;
  title: string;
  status: "ok" | "nominal" | "anomaly" | "failed" | "skipped";
  at: number;
  summary?: string;
}

export interface DailyReportInput {
  since: number;
  now: number;
  activity: WorkspaceActivityEvent[];
  tickets: WorkTicket[];
  tasks: AgentTask[];
  pages: KbPage[];
  memories: MemoryEntry[];
  findings: KbFinding[];
  /** What was found different on the servers, newest first, each line with its time and server. */
  serverChanges?: string[];
  /** What needs attention on the servers right now. */
  serverProblems?: string[];
  /** Problems reported in the previous shift brief, used for novelty filtering of unchanged repeats. */
  previousProblems?: string[];
  /** Configured schedules for deterministic nominal vs anomaly counts. */
  schedules?: AgentSchedule[];
  /** Optional schedule execution history within the reporting window. */
  scheduleRuns?: ScheduleRunSummary[];
  /** Time window in ms for server/time-window incident correlation (default 15 min). */
  correlationWindowMs?: number;
}

const ANOMALY_STATUS_RE = /\b(fail|failed|error|anomaly|anomalous|alert|missed|blocked|timeout|uncertain)\b/i;

function normalizeProblem(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function utcMinute(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)}Z`;
}

interface CorrelatedEvent {
  target: string;
  targetKey: string;
  at: number;
  ref: string;
  label: string;
}

function correlateServerIncidents(
  alerts: WorkTicket[],
  changes: Array<{ c: AgentTask["changes"][number]; who: string }>,
  blockedTickets: WorkTicket[],
  windowMs: number,
): string[] {
  const events: CorrelatedEvent[] = [];
  for (const t of alerts) {
    if (!t.target) continue;
    const at = t.alert?.firstAt ?? t.alert?.lastAt ?? t.updatedAt;
    const clean = t.title.replace(/^Alert(?: \(critical\))?: /, "");
    events.push({
      target: t.target,
      targetKey: t.target.trim().toLowerCase(),
      at,
      ref: `ticket:${t.id}`,
      label: `alert “${clip(clean, 80)}”`,
    });
    for (const corr of t.correlatedAlerts ?? []) {
      events.push({
        target: t.target,
        targetKey: t.target.trim().toLowerCase(),
        at: corr.at,
        ref: corr.fingerprint ? `alert:${corr.fingerprint}` : `ticket:${t.id}:corr`,
        label: clip(corr.summary, 80),
      });
    }
  }
  for (const { c } of changes) {
    if (!c.target) continue;
    events.push({
      target: c.target,
      targetKey: c.target.trim().toLowerCase(),
      at: c.at,
      ref: `change:${c.id}`,
      label: `change “${clip(c.description, 80)}” (${c.rollback?.ran ? c.rollback.comparedWithBaseline && c.rollback.restored ? "restoration verified" : "rollback attempted" : c.status})`,
    });
  }
  for (const t of blockedTickets) {
    if (!t.target) continue;
    events.push({
      target: t.target,
      targetKey: t.target.trim().toLowerCase(),
      at: t.updatedAt,
      ref: `ticket:${t.id}`,
      label: `blocked “${clip(t.title, 80)}”`,
    });
  }

  const byTarget = new Map<string, CorrelatedEvent[]>();
  for (const ev of events) {
    const list = byTarget.get(ev.targetKey) ?? [];
    list.push(ev);
    byTarget.set(ev.targetKey, list);
  }

  const clusters: Array<{ start: number; end: number; target: string; items: CorrelatedEvent[] }> = [];
  for (const list of byTarget.values()) {
    list.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
    let current: CorrelatedEvent[] = [];
    for (const ev of list) {
      if (current.length === 0 || ev.at - current[current.length - 1].at <= windowMs) {
        current.push(ev);
      } else {
        if (new Set(current.map((x) => x.ref)).size >= 2) {
          clusters.push({
            start: current[0].at,
            end: current[current.length - 1].at,
            target: current[0].target,
            items: current,
          });
        }
        current = [ev];
      }
    }
    if (current.length > 0 && new Set(current.map((x) => x.ref)).size >= 2) {
      clusters.push({
        start: current[0].at,
        end: current[current.length - 1].at,
        target: current[0].target,
        items: current,
      });
    }
  }

  clusters.sort((a, b) => a.start - b.start || a.target.localeCompare(b.target));
  return clusters.slice(0, 8).map((cl) => {
    const uniqueRefs = [...new Set(cl.items.map((i) => i.ref))].sort();
    const span = cl.start === cl.end ? utcMinute(cl.start) : `${utcMinute(cl.start)}–${utcMinute(cl.end)}`;
    const labels = [...new Set(cl.items.map((i) => i.label))].slice(0, 3).join("; ");
    return `${cl.target} (${span}, ${uniqueRefs.length} events): ${labels} [refs: ${uniqueRefs.join(", ")}]`;
  });
}

/**
 * What happened in the last day, put together from what the workspace
 * recorded: no model writes this, so it says only what is in the data. It is
 * the morning's answer to "what did the agents and the team do, what went
 * wrong, and what is waiting for me".
 */
export function buildDailyReport(input: DailyReportInput): string {
  const { since } = input;
  const recent = <T>(items: T[], at: (x: T) => number): T[] => items.filter((x) => at(x) >= since);
  const lines: string[] = [];
  const section = (title: string, rows: string[], more = 0): void => {
    if (rows.length === 0) return;
    lines.push(`### ${title}`, ...rows.map((r) => `- ${r}`), ...(more > 0 ? [`- …and ${more} more`] : []), "");
  };
  const cap = <T>(items: T[], n: number): [T[], number] => [items.slice(0, n), Math.max(0, items.length - n)];

  const alerts = recent(input.tickets.filter((t) => t.alert), (t) => t.alert!.lastAt);
  const [alertRows, alertMore] = cap(alerts, 8);
  section(
    "Alerts",
    alertRows.map(
      (t) =>
        `${t.title.replace(/^Alert(?: \(critical\))?: /, "")} — ${t.alert!.resolvedAt ? "resolved" : "still firing"}${t.alert!.count > 1 ? `, fired ${t.alert!.count} times` : ""}${t.correlatedAlerts?.length ? `, +${t.correlatedAlerts.length} correlated` : ""}; ticket is ${t.status === "done" ? "done" : t.status.replace("_", " ")}${t.assigneeName ? ` (${t.assigneeName})` : ", nobody has it"}`,
    ),
    alertMore,
  );

  const changes = input.tasks.flatMap((task) =>
    recent(task.changes, (c) => c.at)
      // A change card, a file write, a settings change or a tool of another system. A plain command is not
      // counted: nothing looks at what a command did.
      .filter((c) => !isPlainCommand(c) && ["completed", "failed", "uncertain"].includes(c.status))
      .map((c) => ({ c, who: task.agentName || "Assistant" })),
  );
  const blockedRecent = recent(input.tickets.filter((t) => t.status === "blocked"), (t) => t.updatedAt);
  const rolledBack = changes.filter((x) => x.c.rollback?.ran);
  const failed = changes.filter((x) => !x.c.rollback?.ran && x.c.status !== "completed");
  section(
    "Went wrong (runs on this computer, and the board)",
    [
      ...rolledBack.map((x) => `${x.who} on ${x.c.target}: ${clip(x.c.description, 120)} — ${x.c.rollback!.exitCode !== 0 ? "the rollback failed" : x.c.rollback!.comparedWithBaseline && x.c.rollback!.restored ? "the rollback was verified" : "the rollback ran and recovery is unverified"}`),
      ...failed.slice(0, 6).map((x) => `${x.who} on ${x.c.target}: ${clip(x.c.description, 120)} — ${x.c.status}${x.c.exitCode !== undefined ? `, exit ${x.c.exitCode}` : ""}`),
      ...(failed.length > 6 ? [`…and ${failed.length - 6} more`] : []),
      ...blockedRecent
        .slice(0, 6)
        .map((t) => `Ticket “${t.title}” stopped: ${clip(t.result ?? "no reason recorded", 160)}`),
    ],
  );

  const correlatedRows = correlateServerIncidents(
    alerts,
    changes,
    blockedRecent,
    input.correlationWindowMs ?? 15 * 60_000,
  );
  section("Correlated incidents", correlatedRows);

  const ok = changes.filter((x) => x.c.status === "completed" && !x.c.rollback?.ran);
  const [okRows, okMore] = cap(ok, 8);
  section(
    "Changed by agents on this computer",
    okRows.map((x) => `${x.who} on ${x.c.target}: ${clip(x.c.description, 120)}${x.c.check?.after && !x.c.check.before ? " (its check showed it worked)" : ""}`),
    okMore,
  );

  // Everyone's, from the shared activity: people, and agents on other computers. This computer's own agent
  // changes are listed above already.
  const own = new Set(input.tasks.flatMap((t) => t.changes.map((c) => `change-${c.id}`)));
  const team = recent(input.activity, (a) => a.at).filter((a) => a.kind !== "ai-action" && !own.has(a.id));
  const [teamRows, teamMore] = cap(team, 8);
  section("Changed by the team (people, and agents on other computers)", teamRows.map((a) => `${a.actor} on ${a.targetLabel}: ${clip(a.summary, 140)}`), teamMore);

  const done = recent(input.tickets.filter((t) => t.status === "done" && !t.alert), (t) => t.updatedAt);
  const [doneRows, doneMore] = cap(done, 8);
  section("Tickets done", doneRows.map((t) => `${t.title}${t.assigneeName ? ` (${t.assigneeName})` : ""}`), doneMore);

  const learnedPages = recent(input.pages.filter((p) => p.updatedBy === "assistant"), (p) => p.updatedAt);
  const learnedMemories = recent(input.memories.filter((m) => m.autoLearned), (m) => m.updatedAt);
  section("Learned", [
    ...learnedPages.slice(0, 6).map((p) => `Page “${p.title}”: ${p.history[0]?.summary ?? "updated"}`),
    ...learnedMemories.slice(0, 6).map((m) => `Memory: ${m.title}`),
  ]);

  if ((input.schedules?.length ?? 0) > 0 || (input.scheduleRuns?.length ?? 0) > 0) {
    const recentRuns = recent(input.scheduleRuns ?? [], (r) => r.at);
    let nominal = 0;
    const anomalies: Array<{ id: string; title: string; status: string; summary?: string }> = [];
    if (recentRuns.length > 0) {
      for (const r of recentRuns) {
        if (r.status === "anomaly" || r.status === "failed") {
          anomalies.push({ id: r.scheduleId, title: r.title, status: r.status, summary: r.summary });
        } else if (r.status === "ok" || r.status === "nominal") {
          nominal++;
        }
      }
    } else {
      for (const s of (input.schedules ?? []).filter((sc) => sc.enabled)) {
        const st = (s.lastStatus ?? "nominal").trim();
        if (ANOMALY_STATUS_RE.test(st)) {
          anomalies.push({ id: s.id, title: s.title, status: st, summary: s.lastRunSummary });
        } else {
          nominal++;
        }
      }
    }
    anomalies.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    section("Schedules", [
      `${nominal} nominal, ${anomalies.length} ${anomalies.length === 1 ? "anomaly" : "anomalies"}`,
      ...anomalies.slice(0, 8).map(
        (a) => `Anomaly: ${a.title} (${a.status})${a.summary ? ` — ${clip(a.summary, 140)}` : ""} [${a.id}]`,
      ),
    ]);
  }

  const [changeRows, changeMore] = cap(input.serverChanges ?? [], 12);
  section("Changed on the servers", changeRows, changeMore);

  const rawProblems = input.serverProblems ?? [];
  const priorSet = new Set((input.previousProblems ?? []).map(normalizeProblem));
  const novelProblems = priorSet.size > 0
    ? rawProblems.filter((p) => !priorSet.has(normalizeProblem(p)))
    : rawProblems;
  const suppressedCount = rawProblems.length - novelProblems.length;
  const [problemRows, problemMore] = cap(novelProblems, 10);
  const problemSectionRows =
    suppressedCount > 0
      ? [
          ...(problemRows.length > 0 ? problemRows : ["No new problems"]),
          `${suppressedCount} unchanged repeat problem${suppressedCount === 1 ? "" : "s"} suppressed`,
        ]
      : problemRows;
  section("Needs attention on the servers", problemSectionRows, problemMore);

  const review = input.tickets.filter((t) => t.status === "review").length;
  const blocked = input.tickets.filter((t) => t.status === "blocked").length;
  const gaps = input.findings.filter((f) => f.kind === "gap").length;
  const contradictions = input.findings.filter((f) => f.kind === "contradiction").length;
  section("Waiting for you", [
    ...(review ? [`${review} ticket${review === 1 ? "" : "s"} to review`] : []),
    ...(blocked ? [`${blocked} blocked ticket${blocked === 1 ? "" : "s"}`] : []),
    ...(gaps ? [`${gaps} question${gaps === 1 ? "" : "s"} agents found nothing on in the knowledge base`] : []),
    ...(contradictions ? [`${contradictions} place${contradictions === 1 ? "" : "s"} where knowledge base pages disagree`] : []),
  ]);

  const period = `Since ${new Date(since).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`;
  return lines.length
    ? `${period}\n\n${lines.join("\n").trim()}`
    : `${period} Nothing was recorded: no alerts, no changes, no tickets.`;
}
