// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findAdjacentElement,
  findAdjacentPane,
  getTopmostOverlay,
  isElementVisible,
  type PaneRect,
} from '../../src/renderer/src/lib/spatialNavigation';

function box(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  el.getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => {},
  });
  return el;
}

function button(id: string, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.createElement('button');
  el.id = id;
  return box(el, rect);
}

describe('isElementVisible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false for an element that is not in the document', () => {
    expect(isElementVisible(document.createElement('div'))).toBe(false);
  });

  describe('with the browser\'s native checkVisibility', () => {
    const withNative = (visible: boolean, rect: { width: number; height: number }) => {
      const el = box(document.createElement('div'), { left: 0, top: 0, ...rect });
      (el as unknown as { checkVisibility: unknown }).checkVisibility = vi.fn(() => visible);
      document.body.appendChild(el);
      return el;
    };

    it('asks for opacity and CSS visibility to be considered', () => {
      const el = withNative(true, { width: 10, height: 10 });
      isElementVisible(el);
      expect((el as unknown as { checkVisibility: ReturnType<typeof vi.fn> }).checkVisibility).toHaveBeenCalledWith({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    });

    it('is false when the browser says the element is not visible, however large it is', () => {
      expect(isElementVisible(withNative(false, { width: 200, height: 200 }))).toBe(false);
    });

    it('is false for a rendered but empty box, and true for one with a size', () => {
      expect(isElementVisible(withNative(true, { width: 0, height: 20 }))).toBe(false);
      expect(isElementVisible(withNative(true, { width: 20, height: 0 }))).toBe(false);
      expect(isElementVisible(withNative(true, { width: 20, height: 20 }))).toBe(true);
    });
  });

  describe('without checkVisibility (the jsdom fallback)', () => {
    it('is true for a plain element', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      expect(isElementVisible(el)).toBe(true);
    });

    it('is false for visibility:hidden and for opacity:0 on the element itself', () => {
      const hidden = document.createElement('div');
      hidden.style.visibility = 'hidden';
      const transparent = document.createElement('div');
      transparent.style.opacity = '0';
      document.body.append(hidden, transparent);
      expect(isElementVisible(hidden)).toBe(false);
      expect(isElementVisible(transparent)).toBe(false);
    });

    it('is false when an ancestor is display:none, because display is not inherited', () => {
      const parent = document.createElement('div');
      parent.style.display = 'none';
      const child = document.createElement('span');
      parent.appendChild(child);
      document.body.appendChild(parent);
      expect(isElementVisible(child)).toBe(false);
    });
  });
});

describe('getTopmostOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lets a visible menu win over any dialog, wherever it is in the document', () => {
    document.body.innerHTML = `
      <div role="dialog" id="dialog" style="z-index: 50"><button>OK</button></div>
      <div class="fixed inset-0" id="backdrop"><div role="menu" id="menu"><button>Item</button></div></div>`;
    expect(getTopmostOverlay()).toBe(document.getElementById('menu'));
  });

  it('returns the dialog inside a full-screen backdrop (fixed inset-0), and the backdrop itself when it holds no dialog', () => {
    document.body.innerHTML = '<div class="fixed inset-0" id="with-dialog"><div role="dialog" id="inner"><button>OK</button></div></div>';
    expect(getTopmostOverlay()).toBe(document.getElementById('inner'));
    document.body.innerHTML = '<div class="fixed inset-0" id="plain"><button>Loading</button></div>';
    expect(getTopmostOverlay()).toBe(document.getElementById('plain'));
  });

  it('picks the inner dialog of two nested ones, even when the outer one has the higher z-index', () => {
    document.body.innerHTML = `
      <div role="dialog" id="outer" style="z-index: 10">
        <div aria-modal="true" id="inner" style="z-index: 1"><button>OK</button></div>
      </div>`;
    expect(getTopmostOverlay()).toBe(document.getElementById('inner'));
  });

  it('picks the sibling dialog with the highest z-index', () => {
    document.body.innerHTML = `
      <div role="dialog" id="low" style="z-index: 5"></div>
      <div role="dialog" id="high" style="z-index: 9"></div>`;
    expect(getTopmostOverlay()).toBe(document.getElementById('high'));
  });

  it('keeps the earlier of two sibling dialogs when it has the higher z-index', () => {
    document.body.innerHTML = `
      <div role="dialog" id="high" style="z-index: 9"></div>
      <div role="dialog" id="low" style="z-index: 5"></div>`;
    expect(getTopmostOverlay()).toBe(document.getElementById('high'));
  });

  it('lets the later one win when two sibling dialogs have the same z-index (it is drawn on top)', () => {
    document.body.innerHTML = `
      <div role="dialog" id="first" style="z-index: 7"></div>
      <div role="dialog" id="second" style="z-index: 7"></div>`;
    expect(getTopmostOverlay()).toBe(document.getElementById('second'));
  });
});

describe('findAdjacentElement wrap-around', () => {
  it('moving right from the last element of the last row wraps to the first element', () => {
    const a = button('a', { left: 10, top: 50, width: 80, height: 30 });
    const b = button('b', { left: 100, top: 50, width: 80, height: 30 });
    expect(findAdjacentElement([a, b], b, 'right')).toBe(a);
  });

  it('moving down from the last row wraps to the first element, and skips the current one if it is first', () => {
    const a = button('a', { left: 10, top: 50, width: 80, height: 30 });
    const b = button('b', { left: 10, top: 100, width: 80, height: 30 });
    expect(findAdjacentElement([a, b], b, 'down')).toBe(a);
    // a row of two: nothing below either, and the current element is the first candidate
    const c = button('c', { left: 10, top: 50, width: 40, height: 30 });
    const d = button('d', { left: 60, top: 50, width: 40, height: 30 });
    expect(findAdjacentElement([c, d], c, 'down')).toBe(d);
  });

  it('moving up from the top element wraps to the last element', () => {
    const top = button('top', { left: 10, top: 50, width: 80, height: 30 });
    const middle = button('middle', { left: 10, top: 100, width: 80, height: 30 });
    const bottom = button('bottom', { left: 10, top: 150, width: 80, height: 30 });
    expect(findAdjacentElement([top, middle, bottom], top, 'up')).toBe(bottom);
  });

  it('moving up with nothing above wraps to the one before the last when the current element is the last', () => {
    // three buttons in one row: none is strictly above another
    const a = button('a', { left: 10, top: 50, width: 40, height: 30 });
    const b = button('b', { left: 60, top: 50, width: 40, height: 30 });
    const c = button('c', { left: 110, top: 50, width: 40, height: 30 });
    expect(findAdjacentElement([a, b, c], c, 'up')).toBe(b);
    expect(findAdjacentElement([a, b, c], a, 'up')).toBe(c);
  });

  it('moving left with nothing before wraps the same way', () => {
    const a = button('a', { left: 10, top: 50, width: 40, height: 30 });
    const b = button('b', { left: 60, top: 50, width: 40, height: 30 });
    const c = button('c', { left: 110, top: 50, width: 40, height: 30 });
    expect(findAdjacentElement([a, b, c], a, 'left')).toBe(c);
  });

  it('returns null for a single element, whichever way it is asked to move', () => {
    const only = button('only', { left: 10, top: 50, width: 40, height: 30 });
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      expect(findAdjacentElement([only], only, direction)).toBeNull();
    }
  });
});

describe('findAdjacentPane never targets the pane that is already active', () => {
  it('goes to the other pane even when the active one is collapsed to a few pixels', () => {
    // A pane 4 px wide lies "in the direction" of itself (its edges are within the tolerance), so it must be skipped explicitly.
    const panes: PaneRect[] = [
      { id: 'collapsed', rect: { left: 0, top: 50, right: 4, bottom: 600, width: 4, height: 550 } },
      { id: 'other', rect: { left: 400, top: 50, right: 800, bottom: 600, width: 400, height: 550 } },
    ];
    expect(findAdjacentPane(panes, 'collapsed', 'right')).toEqual({ type: 'pane', id: 'other' });
    expect(findAdjacentPane(panes, 'other', 'left')).toEqual({ type: 'pane', id: 'collapsed' });
  });
});
