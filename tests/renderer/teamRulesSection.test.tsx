// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { SafetyPolicyCard } from "../../src/renderer/src/components/AiHub/SafetyPolicyCard";
import { TeamRulesSection } from "../../src/renderer/src/components/AiHub/TeamRulesSection";

afterEach(cleanup);

const hub = (teamRules?: HubSnapshot["teamRules"], more: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({ safetyPolicy: { autoApproveSafeReadOnly: true, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true }, teamRules, ...more }) as unknown as HubSnapshot;

describe("the rules for everyone on a server", () => {
  it("is not there where there are none: the desktop app and the demo lab", () => {
    const { container } = render(<TeamRulesSection hub={hub()} act={vi.fn(async () => undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lets an administrator switch the two-person rule and start and end a freeze", () => {
    const act = vi.fn(async () => undefined);
    const until = Date.now() + 3_600_000;
    render(
      <TeamRulesSection
        hub={hub({ canChange: true, requirePeerApprovalOnProd: false, freezes: { "db-prod": { until, by: "Maria Ek", at: 1, why: "Migration" } } }, { peerApprovalPossible: true })}
        act={act}
      />,
    );
    expect(screen.getByTestId("team-rules")).toHaveTextContent("You set these as an administrator. They hold for every account's runs, yours too");
    fireEvent.click(screen.getByTestId("team-peer-toggle"));
    expect(act).toHaveBeenCalledWith({ action: "team-rules-save", requirePeerApprovalOnProd: true });

    const freeze = screen.getByTestId("team-freeze-db-prod");
    expect(freeze).toHaveTextContent("frozen the cluster db-prod until");
    expect(freeze).toHaveTextContent("Set by Maria Ek: Migration");
    // Ending a freeze asks once more before it does it.
    fireEvent.click(within(freeze).getByRole("button", { name: "End it now" }));
    expect(act).not.toHaveBeenCalledWith({ action: "team-rules-save", endFreeze: "db-prod" });
    fireEvent.click(within(freeze).getByRole("button", { name: /End this freeze\?/ }));
    expect(act).toHaveBeenCalledWith({ action: "team-rules-save", endFreeze: "db-prod" });

    // No hours, no freeze. With hours and no cluster it is every server.
    expect(screen.getByTestId("team-freeze-start")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Freeze for how many hours"), { target: { value: "48" } });
    fireEvent.change(screen.getByLabelText("Why the freeze"), { target: { value: "Release weekend" } });
    fireEvent.click(screen.getByTestId("team-freeze-start"));
    expect(act).toHaveBeenCalledWith({ action: "team-rules-save", freeze: { hours: 48, why: "Release weekend" } });
  });

  it("shows a member the rules and gives them nothing to change", () => {
    const act = vi.fn(async () => undefined);
    render(
      <TeamRulesSection
        hub={hub({ canChange: false, requirePeerApprovalOnProd: true, changedBy: "Maria Ek", changedAt: 1_700_000_000_000, freezes: { "*": { until: Date.now() + 60_000, by: "Maria Ek", at: 1 } } }, { peerApprovalPossible: true })}
        act={act}
      />,
    );
    expect(screen.getByTestId("team-rules")).toHaveTextContent("An administrator of this server sets these.");
    expect(screen.getByTestId("team-rules-changed")).toHaveTextContent("Last changed by Maria Ek");
    expect(screen.getByTestId("team-peer-toggle")).toBeChecked();
    expect(screen.getByTestId("team-peer-toggle")).toBeDisabled();
    expect(screen.getByTestId("team-freeze-*")).toHaveTextContent("frozen every server until");
    expect(screen.queryByRole("button", { name: "End it now" })).toBeNull();
    expect(screen.queryByTestId("team-freeze-form")).toBeNull();
  });

  it("says when the rule does not hold for the administrator's own runs yet", () => {
    render(<TeamRulesSection hub={hub({ canChange: true, requirePeerApprovalOnProd: true }, { peerApprovalPossible: false })} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("team-peer-not-you")).toHaveTextContent("It does not hold for your own runs yet");
  });

  it("leaves a person's own two-person switch nothing to decide when the rule is on for everyone, and sends only what was changed", () => {
    const act = vi.fn(async () => undefined);
    const snapshot = hub({ canChange: false, requirePeerApprovalOnProd: true }, { peerApprovalPossible: true });
    snapshot.safetyPolicy = { ...snapshot.safetyPolicy!, requirePeerApprovalOnProd: true, commandAllowPrefixes: ["uptime"], clusterPolicies: {} };
    render(<SafetyPolicyCard hub={snapshot} act={act} />);
    expect(screen.getByTestId("safety-peer-approval-toggle")).toBeChecked();
    expect(screen.getByTestId("safety-peer-approval-toggle")).toBeDisabled();
    expect(screen.getByTestId("safety-peer-for-everyone")).toHaveTextContent("On for everyone on this server");
    // Another switch: the server's rule is not sent back as this person's own, nor are lists they did not touch.
    fireEvent.click(screen.getAllByRole("checkbox").find((c) => !c.hasAttribute("disabled") && !(c as HTMLInputElement).dataset.testid)!);
    const sent = (act.mock.calls as unknown as Array<[{ action: string; policy: Record<string, unknown> }]>).at(-1)![0];
    expect(sent.action).toBe("safety-policy-save");
    expect(Object.keys(sent.policy)).toHaveLength(1);
    expect(sent.policy).not.toHaveProperty("requirePeerApprovalOnProd");
  });
});
