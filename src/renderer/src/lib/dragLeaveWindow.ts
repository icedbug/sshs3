/**
 * Detects an HTML5 drag that was released outside the app window.
 *
 * Coordinates and `relatedTarget` of `dragleave` are unreliable across platforms (Wayland reports
 * the last position inside the window), so this counts enter/leave pairs instead: Chromium fires
 * `dragenter` on the element entered before `dragleave` on the one left, so the count only drops
 * to zero when the pointer has left the window. The drag counts as released outside when it ends
 * in that state without any `drop` event having fired inside the window. (`dropEffect` is not
 * usable: Wayland reports 'copy' even when the drop landed in another application.)
 * Call the returned function to stop watching early; the watch also removes itself when the drag ends.
 */
export function watchDragReleasedOutsideWindow(onReleasedOutside: () => void): () => void {
  let depth = 0;
  let left = false;
  let dropped = false;

  const onDragEnter = (): void => {
    depth++;
    left = false;
  };
  const onDragLeave = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) left = true;
  };
  const onDrop = (): void => {
    dropped = true;
  };
  const stop = (): void => {
    document.removeEventListener('dragenter', onDragEnter, true);
    document.removeEventListener('dragleave', onDragLeave, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('dragend', onDragEnd, true);
  };
  function onDragEnd(): void {
    const fire = left && !dropped;
    stop();
    if (fire) onReleasedOutside();
  }

  document.addEventListener('dragenter', onDragEnter, true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('drop', onDrop, true);
  document.addEventListener('dragend', onDragEnd, true);
  return stop;
}
