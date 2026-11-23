// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryView, AuditVerificationView, HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { AuditLogView } from "../../src/renderer/src/components/AiHub/AuditLogView";

afterEach(cleanup);

/**
 * The audit view had a badge "SIEM sink: …" that named the webhook channels of the notifications, the
 * team bucket or "local only". Nothing sends audit entries to a channel: the badge said something the
 * app does not do. The view now names no place the log is sent to.
 */
const hub = (extra: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { enabled: true, provider: "anthropic", model: "m", useHermes: false, hasApiKey: true },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
    agents: [],
    ...extra,
  }) as unknown as HubSnapshot;

const entries: AuditEntryView[] = [
  { seq: 1, at: Date.UTC(2026, 10, 14, 12, 0, 0), kind: "command", actor: "Alice", target: "web-01", what: "systemctl reload nginx", outcome: "completed", exitCode: 0, hash: "aaaa1111bbbb2222cccc3333" },
];
const verification: AuditVerificationView = { ok: true, entries: 1, anchors: { checked: 1, held: 1, coveredSeq: 1, lastAt: Date.now() } };

const webhook = { id: "c1", kind: "webhook", name: "Splunk SIEM", host: "splunk.internal", hasSecret: true, enabled: true, events: ["approval", "alert"], includeCommand: false, last: { at: Date.now() - 30_000, ok: false, status: 500 } };

const setups: [string, Record<string, unknown>][] = [
  ["nothing connected", {}],
  ["a webhook channel for notifications, whose last delivery failed", { notifications: { channels: [webhook], publicUrl: "", publicUrlFixed: false, reminderMinutes: 5 } }],
  ["a team bucket", { s3Workspace: { configured: true, connected: true, bucket: "team-bucket" } }],
];

describe("the audit log names no place it is sent to", () => {
  it.each(setups)("with %s", async (_name, extra) => {
    const snapshot = hub(extra);
    const request = vi.fn(async (req: HubRequest) => (req.action === "audit-read" ? ({ ...snapshot, reply: { audit: { entries, verification } } } as HubSnapshot) : snapshot));
    render(<AuditLogView request={request} hub={snapshot} onOpenTask={vi.fn()} onWatch={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("audit-chain-badge")).toHaveTextContent("Chain verified · 1 entries"));
    const view = screen.getByTestId("audit-log");
    expect(screen.queryByTestId("siem-sink-badge")).toBeNull();
    expect(view).not.toHaveTextContent(/SIEM|sink|Splunk|delivery error/i);
    // What is true about the team bucket stays: the anchors that were checked.
    expect(view).toHaveTextContent("anchors in the team bucket match it");
  });
});
