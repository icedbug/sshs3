import { describe, expect, it } from "vitest";
import type { AnswerSourceCall } from "../../src/shared/answerSources";
import type { AgentTask, WorkTicket } from "../../src/shared/types/aiHub";
import { parseHypotheses } from "../../src/main/ai/hub/AgentDiscipline";
import { evidenceKey, supersededEvidence } from "../../src/shared/incidentEvidence";
import { mergeTicketCopies, ticketAfterRun } from "../../src/main/ai/hub/WorkBoard";

const call: AnswerSourceCall = {
  id: "call-1", at: 10, sources: [
    { ref: "S1", kind: "kb-page", id: "manual", revision: 2, digest: "abc", label: "Private runbook" },
    { ref: "S2", kind: "terminal", id: "s1", observedAt: 9, digest: "def", label: "host", excerpt: "bounded terminal output" },
    { ref: "S3", kind: "kb-document", id: "index", digest: "ghi", label: "index entry", indexOnly: true },
  ],
};
const ticket: WorkTicket = { id: "t", title: "Disk alert", description: "", createdAt: 1, updatedAt: 1, createdBy: "team", status: "in_progress" };
const rawTask = { id: "r", messages: [], status: "completed" } as unknown as AgentTask;
const hypothesis = (evidence: object[], status = "open") => ({ id: "h1", text: "Quota exhaustion", status, evidence });

describe("incident evidence and diagnostic handover", () => {
  it("validates source references against the actual call and refuses index-only entries", () => {
    for (const ref of ["S99", "S3"]) {
      expect(parseHypotheses({ hypotheses: [hypothesis([{ text: "Reading", supports: true, sourceRef: ref }])] }, { taskId: "r", call }))
        .toMatchObject({ error: expect.stringContaining(ref) });
    }
  });

  it("keeps the original observation, pins its revision, and revises the diagnosis independently of run completion", () => {
    const first = parseHypotheses({ hypotheses: [hypothesis([{ id: "old", text: "Quota matched the symptom", supports: true, sourceRef: "S1" }], "confirmed")] },
      { taskId: "r", at: 11, call });
    if ("error" in first) throw Error(first.error);
    expect(first.hypotheses[0].evidence[0]).toMatchObject({ at: 11, source: { callId: "call-1", taskId: "r", ref: "S1", revision: 2, digest: "abc" } });
    const established = ticketAfterRun(ticket, { ...rawTask, hypotheses: first.hypotheses }, 12);
    expect(established).toMatchObject({ status: "review", diagnosis: { status: "confirmed", cause: "Quota exhaustion" } });
    const nextObservation = "Capture the queue depth on the next slow request.";
    const updated = parseHypotheses({ hypotheses: [hypothesis([{ id: "new", text: "Quota is larger than usage", supports: false, sourceRef: "S2", supersedes: "old" }])], nextObservation },
      { taskId: "r", at: 14, previous: first.hypotheses, call: { ...call, id: "call-2" } });
    if ("error" in updated) throw Error(updated.error);
    expect(updated.hypotheses[0].evidence.map(e => [e.id, e.at, e.supersedes])).toEqual([["old", 11, undefined], ["new", 14, "old"]]);
    const held = ticketAfterRun(established, { ...rawTask, hypotheses: updated.hypotheses, nextDiagnosticObservation: updated.nextObservation }, 15);
    const repeated = parseHypotheses({ hypotheses: [hypothesis([{ id: "new", text: "Quota is larger than usage", supports: false }])] },
      { taskId: "r", at: 16, previous: updated.hypotheses, call: { ...call, sources: [] } });
    expect(repeated).toMatchObject({ hypotheses: updated.hypotheses });
    for (const synced of [mergeTicketCopies(held, established), mergeTicketCopies(established, held)]) {
      expect(synced).toMatchObject({ status: "review", diagnosis: { status: "insufficient-evidence", nextObservation }, hypotheses: [{ status: "open", evidence: [{ id: "old" }, { id: "new" }] }] });
      expect(JSON.stringify(synced)).not.toMatch(/Private runbook|bounded terminal output/);
    }
    const edited = parseHypotheses({ hypotheses: [hypothesis([{ id: "old", text: "Rewritten history", supports: true }])] },
      { taskId: "r", previous: updated.hypotheses, call });
    expect(edited).toMatchObject({ error: expect.stringContaining("already exists") });
  });

  it("retains equally named observations recorded by separate runs on the same ticket", () => {
    const a = parseHypotheses({ hypotheses: [hypothesis([{ id: "e1", text: "First run", supports: true }])] }, { taskId: "run-a", at: 1 });
    const b = parseHypotheses({ hypotheses: [hypothesis([
      { id: "e1", text: "Second run", supports: true },
      { id: "e2", supersedes: "e1", text: "Rechecked the second run", supports: false },
    ])] }, { taskId: "run-b", at: 2 });
    if ("error" in a || "error" in b) throw Error("Fixture should parse");
    const first = { ...ticket, hypotheses: a.hypotheses, updatedAt: 10 };
    const second = { ...ticket, hypotheses: b.hypotheses, updatedAt: 20 };
    const merged = mergeTicketCopies(first, second).hypotheses![0].evidence;
    const replaced = supersededEvidence(merged);
    expect(merged).toHaveLength(3);
    expect(merged.filter(item => replaced.has(evidenceKey(item))).map(item => item.text)).toEqual(["Second run"]);
    expect(mergeTicketCopies(second, first).hypotheses![0].evidence).toEqual(merged);
  });

  it("keeps legacy unlinked reports readable without declaring them source-backed", () => {
    const stored = { id: "h", text: "Latency", status: "confirmed" as const, evidence: [{ text: "from a previous version", supports: true }] };
    expect(ticketAfterRun(ticket, { ...rawTask, hypotheses: [stored] }).diagnosis?.status).toBe("insufficient-evidence");
    expect(ticketAfterRun(ticket, rawTask).diagnosis).toBeUndefined();
  });
});
