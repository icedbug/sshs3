/** Keyboard movement for roving-focus widgets: menus (vertical) and tab strips (horizontal). */

/**
 * Arrow-key movement inside a menu (WAI-ARIA menu pattern): ArrowDown/ArrowUp step through the items and wrap, Home and
 * End jump to the ends. Returns the index to focus, or null when the key is not a menu navigation key.
 */
export function nextMenuIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Horizontal counterpart for a tab strip: ArrowRight/ArrowLeft step and wrap, Home and End jump to the ends.
 * Returns the index to focus, or null for any other key.
 */
export function nextTabIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowLeft':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
