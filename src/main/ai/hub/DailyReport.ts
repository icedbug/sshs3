import type {
  AgentTask,
  KbFinding,
  KbPage,
  MemoryEntry,
  WorkTicket,
  WorkspaceActivityEvent,
} from "../../../shared/types/aiHub";
import { clip } from "./privacy";

/**
 * What happened in the last day, put together from what the workspace
 * recorded: no model writes this, so it says only what is in the data. It is
 * the morning's answer to "what did the agents and the team do, what went
 * wrong, and what is waiting for me".
 */
export function buildDailyReport(input: {
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
}): string {
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
        `${t.title.replace(/^Alert(?: \(critical\))?: /, "")} — ${t.alert!.resolvedAt ? "resolved" : "still firing"}${t.alert!.count > 1 ? `, fired ${t.alert!.count} times` : ""}; ticket is ${t.status === "done" ? "done" : t.status.replace("_", " ")}${t.assigneeName ? ` (${t.assigneeName})` : ", nobody has it"}`,
    ),
    alertMore,
  );

  const changes = input.tasks.flatMap((task) =>
    recent(task.changes, (c) => c.at)
      .filter((c) => (c.riskLevel ?? "modify") !== "safe" && ["completed", "failed", "uncertain"].includes(c.status))
      .map((c) => ({ c, who: task.agentName || "Assistant" })),
  );
  const rolledBack = changes.filter((x) => x.c.rollback?.ran);
  const failed = changes.filter((x) => !x.c.rollback?.ran && x.c.status !== "completed");
  section(
    "Went wrong (runs on this computer, and the board)",
    [
      ...rolledBack.map((x) => `${x.who} on ${x.c.target}: ${clip(x.c.description, 120)} — its check failed and it was ${x.c.rollback!.exitCode !== 0 ? "NOT rolled back (the rollback failed)" : x.c.rollback!.restored === false ? "rolled back, but the check does not read as before" : "rolled back"}`),
      ...failed.slice(0, 6).map((x) => `${x.who} on ${x.c.target}: ${clip(x.c.description, 120)} — ${x.c.status}${x.c.exitCode !== undefined ? `, exit ${x.c.exitCode}` : ""}`),
      ...(failed.length > 6 ? [`…and ${failed.length - 6} more`] : []),
      ...recent(input.tickets.filter((t) => t.status === "blocked"), (t) => t.updatedAt)
        .slice(0, 6)
        .map((t) => `Ticket “${t.title}” stopped: ${clip(t.result ?? "no reason recorded", 160)}`),
    ],
  );

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

  const [changeRows, changeMore] = cap(input.serverChanges ?? [], 12);
  section("Changed on the servers", changeRows, changeMore);
  const [problemRows, problemMore] = cap(input.serverProblems ?? [], 10);
  section("Needs attention on the servers", problemRows, problemMore);

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
