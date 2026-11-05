const MARGIN = 16;

export type HoverCardSide = 'below' | 'above';

/**
 * Which side of the pointer a card opens on, decided once from the room for the tallest the card can
 * become (a preview arrives after the first paint). Deciding from the current height instead makes the
 * card jump from below to above the pointer when the preview loads, away from a pointer that has moved
 * into it. When neither side has room for the tallest card, the side with more room wins.
 */
export function chooseHoverCardSide(opts: { y: number; reserveHeight: number; viewportHeight: number }): HoverCardSide {
  const { y, reserveHeight, viewportHeight } = opts;
  const roomBelow = viewportHeight - MARGIN - (y + MARGIN);
  const roomAbove = y - MARGIN - MARGIN;
  if (roomBelow >= reserveHeight) return 'below';
  if (roomAbove >= reserveHeight) return 'above';
  return roomBelow >= roomAbove ? 'below' : 'above';
}

/** The height available for a card on `side` of the pointer, between the pointer and the viewport edge. */
export function hoverCardRoom(opts: { y: number; side: HoverCardSide; viewportHeight: number }): number {
  const { y, side, viewportHeight } = opts;
  return side === 'below' ? viewportHeight - MARGIN - (y + MARGIN) : y - MARGIN - MARGIN;
}

/**
 * Top-left corner for a card opened at (x, y): right of the pointer and, unless `side` says otherwise,
 * below it when it fits, otherwise flipped to the left / above, and finally clamped so the whole card
 * stays inside the viewport. A given `side` is kept even when the card grows.
 */
export function placeHoverCard(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  side?: HoverCardSide;
}): { left: number; top: number } {
  const { x, y, width, height, viewportWidth, viewportHeight, side } = opts;

  let left = x + 12;
  if (left + width > viewportWidth - MARGIN) left = x - width - 12;
  left = Math.max(MARGIN, Math.min(left, viewportWidth - MARGIN - width));

  let top = y + MARGIN;
  if (side === 'above') top = y - height - MARGIN;
  else if (!side && top + height > viewportHeight - MARGIN) top = y - height - MARGIN;
  top = Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - height));

  return { left, top };
}
