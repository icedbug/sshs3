import { useState } from "react";
import type { AgentChange, HubRequest, HubSnapshot } from "../../../../shared/types/aiHub";
import { copyToClipboard } from "../../lib/clipboard";

/**
 * The secrets a setting needs, typed where it is approved, and the one-time things a setting makes,
 * shown where it was approved. Both stay out of the conversation, so the model's provider never reads
 * them: a token goes from this card to sshs3 with the approval, and a new key or code comes from
 * sshs3 to this card once.
 */

type Act = (request: HubRequest) => Promise<HubSnapshot | void>;

/** Whether a waiting change is answered with secrets, which only the conversation's own card can take. */
export const takesSecrets = (change: Pick<AgentChange, "secretFields" | "status"> | undefined): boolean =>
  Boolean(change && change.status === "pending" && change.secretFields?.length);

/** What other places that list a waiting change say, in place of their own Approve button. */
export const SECRETS_ELSEWHERE = "This one takes a token or key. Open the conversation and answer it there.";

/** The fields of a waiting change that takes secrets. The values live here until the approval is sent. */
export function ChangeSecretInputs({
  change,
  values,
  onChange,
}: {
  change: AgentChange;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element | null {
  // A long address typed blind is typed wrong: the person may look at it while they type.
  const [visible, setVisible] = useState(false);
  if (!takesSecrets(change)) return null;
  const hintId = `ai-change-secrets-hint-${change.id}`;
  return (
    <div className="ai-form" data-testid={`ai-change-secrets-${change.id}`}>
      {change.secretFields!.map((field) => (
        <label key={field.key}>
          <span>
            Type {field.label}
            {field.optional ? ". Leave it empty to keep the one already saved." : ""}
          </span>
          <input
            type={visible ? "text" : "password"}
            // Not a sign-in: a browser or a password manager is asked not to fill it in or to keep it.
            autoComplete="new-password"
            data-1p-ignore=""
            data-lpignore="true"
            spellCheck={false}
            aria-label={`Type ${field.label}`}
            aria-describedby={hintId}
            value={values[field.key] ?? ""}
            onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
          />
        </label>
      ))}
      <label className="ai-check">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        <span>Show what I type</span>
      </label>
      <small className="ai-hint" id={hintId}>
        What you type here goes to sshs3 with your approval. It is not part of the conversation and is not sent to the model.
      </small>
    </div>
  );
}

/**
 * What a finished change made for the person alone: asked for once, shown until the card is closed.
 * `onShown` tells the card that it now holds the value, so it stays open while the person copies it:
 * asking for it marks the change as shown, and a card that folded away on that would hide it at once.
 */
export function ChangeReveal({ taskId, change, act, onShown }: { taskId: string; change: AgentChange; act: Act; onShown?: () => void }): JSX.Element | null {
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!change.reveal) return null;
  if (shown)
    return (
      <div className="ai-form" data-testid={`ai-change-reveal-${change.id}`}>
        {shown.value ? (
          <>
            <span>{shown.label}. It is shown this once: copy it now.</span>
            <pre className="ai-mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid={`ai-change-reveal-value-${change.id}`}>
              {shown.value}
            </pre>
            <button
              type="button"
              className="ai-mini-btn"
              onClick={() => {
                // Also where the page is not served over https, which a team server may not be.
                void copyToClipboard(shown.value).then((ok) => setCopied(ok));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </>
        ) : (
          <span>It is no longer kept: it was shown already, or sshs3 restarted since. Make a new one.</span>
        )}
      </div>
    );
  if (change.reveal.shown) return <small className="ai-hint">{change.reveal.label} was shown once and is not kept.</small>;
  return (
    <div className="ai-form" data-testid={`ai-change-reveal-${change.id}`}>
      <button
        type="button"
        className="ai-primary"
        onClick={() => {
          void act({ action: "change-reveal", taskId, changeId: change.id }).then((snap) => {
            const got = snap?.reply?.changeReveal;
            if (got) {
              setShown(got);
              onShown?.();
            }
          });
        }}
      >
        Show it once
      </button>
      <small className="ai-hint">{change.reveal.label} is shown one time only, here. The agent in this conversation is not given it.</small>
    </div>
  );
}
