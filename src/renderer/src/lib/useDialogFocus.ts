import { useEffect, useRef, type RefObject } from 'react';
import { getTabbables, nextTrapTarget } from './dialogFocus';

/** Active traps, oldest first: only the last one handles Tab, so a dialog opened from a dialog traps on its own. */
const trapStack: symbol[] = [];

/**
 * The element focused just before the current one. A dialog that takes focus while it mounts (a React
 * `autoFocus`) has already moved focus by the time the hook's effect runs, so the opener can only be
 * recovered from this history.
 *
 * Weak references on purpose: a removed element (a PIN or password input whose dialog closed) must not be
 * kept alive, with whatever value it holds, just because it was the last thing focused.
 */
let currentFocus: WeakRef<HTMLElement> | null = null;
let previousFocus: WeakRef<HTMLElement> | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      if (e.target instanceof HTMLElement && e.target !== currentFocus?.deref()) {
        previousFocus = currentFocus;
        currentFocus = new WeakRef(e.target);
      }
    },
    true
  );
}

function findOpener(container: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  const candidate = active && container.contains(active) ? (previousFocus?.deref() ?? null) : active;
  return candidate instanceof HTMLElement && candidate !== document.body && !container.contains(candidate)
    ? candidate
    : null;
}

/**
 * Keyboard focus handling for a modal dialog, the part `useModalDismiss` (Escape and backdrop) leaves out:
 *
 * - on open, focus moves into the dialog: to `[data-autofocus]` if the dialog marks one, else the first
 *   tabbable element. Focus that is already inside (a React `autoFocus`) is left alone, so a confirmation
 *   that defaults to Cancel keeps doing so;
 * - Tab and Shift+Tab wrap at the dialog's edges instead of reaching the page behind it;
 * - when the dialog is removed, focus goes back to the element that had it before the dialog opened.
 *
 * Attach `containerRef` to the element carrying `role="dialog"`. Escape is not handled here.
 */
export function useDialogFocus(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  // Kept across effect runs: React StrictMode runs the effect twice on mount, and by the second run the
  // dialog already holds focus, so the opener could no longer be read from `document.activeElement`.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    openerRef.current ??= findOpener(container);

    const token = Symbol('dialog-focus');
    trapStack.push(token);

    if (!container.contains(document.activeElement)) {
      const target =
        container.querySelector<HTMLElement>('[data-autofocus]') ?? getTabbables(container)[0] ?? container;
      if (target === container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      target.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      if (trapStack[trapStack.length - 1] !== token) return;
      const focused = document.activeElement;
      // Focus inside another modal (one not wired to this hook yet) is that modal's business.
      if (focused && !container.contains(focused) && focused.closest('[aria-modal="true"]')) return;
      const target = nextTrapTarget(getTabbables(container), focused, container, e.shiftKey);
      if (!target) return;
      e.preventDefault();
      if (target === container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      target.focus();
    };
    // Bubble phase on purpose: a widget inside the dialog that owns Tab (an editor indenting) calls
    // preventDefault first and is left alone.
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = trapStack.indexOf(token);
      if (at !== -1) trapStack.splice(at, 1);
      // Deferred so the unmount has happened: a dialog that is still in the document means this was a
      // StrictMode re-run, not a close.
      setTimeout(() => {
        if (container.isConnected) return;
        const opener = openerRef.current;
        openerRef.current = null;
        const now = document.activeElement;
        if (opener?.isConnected && (!now || now === document.body)) opener.focus();
      }, 0);
    };
  }, [active, containerRef]);
}
