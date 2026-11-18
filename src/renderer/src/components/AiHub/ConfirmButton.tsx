import { useEffect, useRef, useState, type CSSProperties } from "react";

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
  /** How long (ms) the pending confirm state stays armed before resetting. Defaults to 10000ms. */
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
  confirmTimeoutMs = 10_000,
}: ConfirmButtonProps): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [remainingMs, setRemainingMs] = useState(confirmTimeoutMs);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const paused = hovered || focused;
  const secondsLeft = Math.max(1, Math.ceil(remainingMs / 1000));

  useEffect(() => {
    if (!asking || paused) return;
    let last = Date.now();
    const tick = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      setRemainingMs((prev) => Math.max(0, prev - elapsed));
    }, 250);
    return () => window.clearInterval(tick);
  }, [asking, paused]);

  useEffect(() => {
    if (asking && remainingMs <= 0) {
      setAsking(false);
    }
  }, [asking, remainingMs]);

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

  const arm = (): void => {
    setRemainingMs(confirmTimeoutMs);
    setAsking(true);
  };

  return (
    <span
      ref={wrapRef}
      className="ai-confirm-wrap"
      style={{ display: "inline-flex", alignItems: "center", gap: 4, position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          setAsking(false);
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        className={className + (asking ? " ai-btn-confirming" : "")}
        aria-label={asking ? confirmLabel : (ariaLabel ?? label)}
        data-confirming={asking ? "true" : undefined}
        onClick={() => {
          if (disabled) return;
          if (!asking) return arm();
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
      >
        <span>{asking ? confirmLabel : label}</span>
        {/* The seconds are shown only while they run: with the pointer on it or the focus in it, the question waits. */}
        {asking && !paused && (
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
      {asking && (
        <button
          type="button"
          data-testid="confirm-cancel"
          aria-label="Cancel"
          onClick={() => setAsking(false)}
        >
          Cancel
        </button>
      )}
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
