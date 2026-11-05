export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };
/**
 * Smallest window the UI is laid out for: below this the file manager toolbar and the dialogs clip their
 * controls. Also given to BrowserWindow as minWidth/minHeight, so dragging cannot go below it either.
 */
export const MIN_WINDOW_SIZE = { width: 1024, height: 600 };

/**
 * The minimum size for a display: MIN_WINDOW_SIZE, but never larger than that display's work area. On a small or heavily
 * scaled screen (1366x768 at 150% leaves about 910 DIPs) a hard 1024 would make the window wider than the screen, with
 * controls off-screen and no way to shrink it.
 */
export function minimumSizeFor(workArea: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(MIN_WINDOW_SIZE.width, workArea.width),
    height: Math.min(MIN_WINDOW_SIZE.height, workArea.height),
  };
}
/** How much of a restored window must overlap a display for the title bar to stay reachable. */
const MIN_VISIBLE = { width: 120, height: 60 };

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function isFiniteRect(value: Rect | undefined | null): value is Rect {
  return (
    !!value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function centered(size: { width: number; height: number }, workArea: Rect): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * Validates saved window bounds against the displays that are connected now. Bounds that still
 * overlap a display are kept (clamped to at least a usable size); anything else (monitor unplugged,
 * resolution changed, corrupt value) falls back to a centered window on the primary display.
 */
export function resolveWindowBounds(saved: Rect | undefined | null, workAreas: Rect[], primary: Rect): Rect {
  if (!isFiniteRect(saved)) return centered(DEFAULT_WINDOW_SIZE, primary);

  const min = minimumSizeFor(primary);
  const size = {
    width: Math.max(min.width, Math.round(saved.width)),
    height: Math.max(min.height, Math.round(saved.height)),
  };
  const candidate: Rect = { x: Math.round(saved.x), y: Math.round(saved.y), ...size };
  const visible = workAreas.some((area) => {
    const o = overlap(candidate, area);
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height;
  });
  return visible ? candidate : centered(size, primary);
}

/**
 * Where a new window goes: centered on the display the pointer is on, so it lands on the monitor the
 * user is working at. When that is the same display as the focused window, cascade from it instead
 * of stacking exactly on top.
 */
export function placeNewWindow(
  cursorWorkArea: Rect,
  focused?: { bounds: Rect; workArea: Rect } | null
): Rect {
  const sameDisplay =
    !!focused &&
    focused.workArea.x === cursorWorkArea.x &&
    focused.workArea.y === cursorWorkArea.y &&
    focused.workArea.width === cursorWorkArea.width &&
    focused.workArea.height === cursorWorkArea.height;
  if (sameDisplay && focused) {
    const cascade = { ...focused.bounds, x: focused.bounds.x + 30, y: focused.bounds.y + 30 };
    return resolveWindowBounds(cascade, [cursorWorkArea], cursorWorkArea);
  }
  return centered(DEFAULT_WINDOW_SIZE, cursorWorkArea);
}
