import { useEffect, useState } from "react";

/** A button for something that cannot be undone: the first click asks, the second does it. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "ai-btn-danger",
  ariaLabel,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  ariaLabel?: string;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = window.setTimeout(() => setAsking(false), 4000);
    return () => window.clearTimeout(timer);
  }, [asking]);
  return (
    <button
      type="button"
      className={className + (asking ? " ai-btn-confirming" : "")}
      aria-label={asking ? confirmLabel : (ariaLabel ?? label)}
      onClick={() => {
        if (!asking) return setAsking(true);
        setAsking(false);
        onConfirm();
      }}
      onBlur={() => setAsking(false)}
    >
      {asking ? confirmLabel : label}
    </button>
  );
}
