import { useEffect, useState, type CSSProperties } from "react";

const SR_ONLY_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface ConfirmButtonProps {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  ariaLabel?: string;
  /** Optional keyboard shortcut hint badge (e.g. "Del", "Esc"). */
  shortcutHint?: string;
  disabled?: boolean;
  /** How long (ms) the pending confirm state stays armed before resetting. Defaults to 4000ms. */
  confirmTimeoutMs?: number;
}

/** A button for something that cannot be undone: the first click asks, the second does it. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "ai-btn-danger",
  ariaLabel,
  shortcutHint,
  disabled = false,
  confirmTimeoutMs = 4000,
}: ConfirmButtonProps): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // The question goes away by itself. The seconds left are shown, so it does not vanish without warning.
  useEffect(() => {
    if (!asking) return;
    const until = Date.now() + confirmTimeoutMs;
    setSecondsLeft(Math.ceil(confirmTimeoutMs / 1000));
    const tick = window.setInterval(() => setSecondsLeft(Math.max(1, Math.ceil((until - Date.now()) / 1000))), 250);
    const timer = window.setTimeout(() => setAsking(false), confirmTimeoutMs);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [asking, confirmTimeoutMs]);

  useEffect(() => {
    if (!asking) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAsking(false);
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [asking]);

  return (
    <span className="ai-confirm-wrap" style={{ display: "inline-flex", position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        className={className + (asking ? " ai-btn-confirming" : "")}
        aria-label={asking ? confirmLabel : (ariaLabel ?? label)}
        data-confirming={asking ? "true" : undefined}
        onClick={() => {
          if (disabled) return;
          if (!asking) return setAsking(true);
          setAsking(false);
          onConfirm();
        }}
        onKeyDown={(event) => {
          if (asking && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setAsking(false);
          }
        }}
        onBlur={() => setAsking(false)}
      >
        <span>{asking ? confirmLabel : label}</span>
        {asking && (
          <span className="ai-confirm-count" data-testid="confirm-countdown" aria-hidden="true">
            ({secondsLeft})
          </span>
        )}
        {shortcutHint && (
          <kbd className="ai-confirm-shortcut" aria-hidden="true">
            {shortcutHint}
          </kbd>
        )}
      </button>
      <span
        className="ai-sr-only"
        role={asking ? "status" : undefined}
        aria-live="polite"
        style={SR_ONLY_STYLE}
      >
        {asking ? `${confirmLabel}. Press Escape to cancel.` : ""}
      </span>
    </span>
  );
}
