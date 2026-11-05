// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchDragReleasedOutsideWindow } from '../../src/renderer/src/lib/dragLeaveWindow';

const fire = (type: string, dropEffect = 'none'): void => {
  const e = new Event(type, { bubbles: true }) as Event & { dataTransfer?: { dropEffect: string } };
  e.dataTransfer = { dropEffect };
  document.dispatchEvent(e);
};

describe('watchDragReleasedOutsideWindow', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('fires when every entered element was left before the drag ended', () => {
    const cb = vi.fn();
    stop = watchDragReleasedOutsideWindow(cb);
    fire('dragenter'); // row
    fire('dragenter'); // pane (entered before the row is left)
    fire('dragleave');
    fire('dragleave'); // left the window
    fire('dragend');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the pointer moves between elements inside the window', () => {
    const cb = vi.fn();
    stop = watchDragReleasedOutsideWindow(cb);
    fire('dragenter');
    fire('dragenter');
    fire('dragleave'); // still inside the second element
    fire('dragend');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire when a drop happened inside the window', () => {
    const cb = vi.fn();
    stop = watchDragReleasedOutsideWindow(cb);
    fire('dragenter');
    fire('dragleave');
    fire('drop');
    fire('dragend', 'copy');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire when the drag came back inside before ending', () => {
    const cb = vi.fn();
    stop = watchDragReleasedOutsideWindow(cb);
    fire('dragenter');
    fire('dragleave'); // out
    fire('dragenter'); // and back in
    fire('dragend');
    expect(cb).not.toHaveBeenCalled();
  });

  it('removes itself after the drag ends and when stopped early', () => {
    const cb = vi.fn();
    stop = watchDragReleasedOutsideWindow(cb);
    fire('dragend');
    fire('dragenter');
    fire('dragleave');
    fire('dragend');
    expect(cb).not.toHaveBeenCalled();

    stop = watchDragReleasedOutsideWindow(cb);
    stop();
    fire('dragenter');
    fire('dragleave');
    fire('dragend');
    expect(cb).not.toHaveBeenCalled();
  });
});
