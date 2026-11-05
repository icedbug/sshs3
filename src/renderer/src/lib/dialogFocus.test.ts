// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { getTabbables, nextTrapTarget } from './dialogFocus';

function dialog(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('getTabbables', () => {
  it('returns focusable elements in DOM order', () => {
    const d = dialog('<button id="a"></button><a href="#" id="b"></a><input id="c"><select id="d"></select><textarea id="e"></textarea>');
    expect(getTabbables(d).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('skips disabled controls, tabindex -1, hidden inputs, hidden and inert subtrees', () => {
    const d = dialog(`
      <button id="ok"></button>
      <button id="off" disabled></button>
      <div id="roving" tabindex="-1"></div>
      <input id="hid" type="hidden">
      <div hidden><button id="in-hidden"></button></div>
      <div inert><button id="in-inert"></button></div>
      <fieldset disabled><input id="in-fieldset"></fieldset>
      <a id="no-href"></a>
    `);
    expect(getTabbables(d).map((e) => e.id)).toEqual(['ok']);
  });

  it('includes an element with tabindex 0', () => {
    const d = dialog('<div id="t" tabindex="0"></div>');
    expect(getTabbables(d).map((e) => e.id)).toEqual(['t']);
  });

  it('keeps only the checked radio of a group, or every radio when none is checked', () => {
    const checked = dialog('<input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2" checked><input type="radio" name="g" id="r3">');
    expect(getTabbables(checked).map((e) => e.id)).toEqual(['r2']);
    document.body.innerHTML = '';
    const none = dialog('<input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2">');
    expect(getTabbables(none).map((e) => e.id)).toEqual(['r1', 'r2']);
  });
});

describe('nextTrapTarget', () => {
  function setup() {
    const d = dialog('<button id="a"></button><button id="b"></button><button id="c"></button>');
    const t = getTabbables(d);
    return { d, t, a: t[0], b: t[1], c: t[2] };
  }

  it('wraps forward from the last element to the first', () => {
    const { d, t, a, c } = setup();
    expect(nextTrapTarget(t, c, d, false)).toBe(a);
  });

  it('wraps backward from the first element to the last', () => {
    const { d, t, a, c } = setup();
    expect(nextTrapTarget(t, a, d, true)).toBe(c);
  });

  it('leaves movement inside the dialog to the browser', () => {
    const { d, t, a, b } = setup();
    expect(nextTrapTarget(t, b, d, false)).toBeNull();
    expect(nextTrapTarget(t, b, d, true)).toBeNull();
    expect(nextTrapTarget(t, a, d, false)).toBeNull();
  });

  it('pulls focus that is outside the dialog in, to the first element or, going back, the last', () => {
    const { d, t, a, c } = setup();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    expect(nextTrapTarget(t, outside, d, false)).toBe(a);
    expect(nextTrapTarget(t, outside, d, true)).toBe(c);
    expect(nextTrapTarget(t, null, d, false)).toBe(a);
  });

  it('sends Shift+Tab from the dialog container itself to the last element', () => {
    const { d, t, c } = setup();
    expect(nextTrapTarget(t, d, d, true)).toBe(c);
    expect(nextTrapTarget(t, d, d, false)).toBeNull();
  });

  it('keeps focus on the container when there is nothing to tab to', () => {
    const d = dialog('<p>Nothing to focus</p>');
    expect(nextTrapTarget([], null, d, false)).toBe(d);
  });
});
