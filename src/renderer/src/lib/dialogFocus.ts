/**
 * Pure focus helpers for modal dialogs (see `useDialogFocus`). No React and no module state, so the
 * edge-wrapping rules can be tested without rendering anything.
 */

const TABBABLE_SELECTOR =
  'a[href], button, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [tabindex]';

function isRendered(el: HTMLElement): boolean {
  // `checkVisibility` is missing in jsdom: treat every element as rendered there.
  return typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkVisibilityCSS: true }) : true;
}

/** An unchecked radio is skipped when another radio of its group is checked: the browser tabs to the checked one only. */
function isShadowedRadio(el: HTMLElement, container: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.checked || !el.name) return false;
  const scope: ParentNode = el.form ?? container;
  return Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')).some(
    (r) => r.name === el.name && r.checked
  );
}

/** Every element inside `container` that Tab can reach, in DOM order. */
export function getTabbables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.matches(':disabled')) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.closest('[inert], [hidden]')) return false;
    if (isShadowedRadio(el, container)) return false;
    return isRendered(el);
  });
}

/**
 * Where a Tab press must send focus to keep it inside `container`, or `null` when the browser's own
 * movement already stays inside. Only the edges (and focus that is outside) need intervention.
 */
export function nextTrapTarget(
  tabbables: HTMLElement[],
  active: Element | null,
  container: HTMLElement,
  backwards: boolean
): HTMLElement | null {
  if (tabbables.length === 0) return container;
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (!active || !container.contains(active)) return backwards ? last : first;
  if (backwards && (active === first || active === container)) return last;
  if (!backwards && active === last) return first;
  return null;
}
