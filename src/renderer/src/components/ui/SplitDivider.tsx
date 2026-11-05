import React, { useCallback, useRef } from 'react';

export interface SplitDividerProps {
  orientation: 'vertical' | 'horizontal';
  /** The ratio (0-1) the first/left/top side of the split currently occupies. */
  ratio: number;
  onChange: (ratio: number) => void;
  /** The element whose bounding box the drag ratio is computed against — the split's own
   * container, not the divider itself (which has ~0 width/height along the drag axis). */
  containerRef: React.RefObject<HTMLElement>;
  minRatio?: number;
  maxRatio?: number;
  label?: string;
}

const DEFAULT_MIN = 0.1;
const DEFAULT_MAX = 0.9;
const NUDGE_STEP = 0.05;

/**
 * A draggable divider between two resizable panes (§23) — shared by the dual-pane file manager
 * and terminal splits rather than reimplemented per call site. Pure in the sense that it owns no
 * ratio state itself (controlled via `ratio`/`onChange`): the caller decides whether/how to
 * persist it.
 */
export const SplitDivider: React.FC<SplitDividerProps> = ({
  orientation,
  ratio,
  onChange,
  containerRef,
  minRatio = DEFAULT_MIN,
  maxRatio = DEFAULT_MAX,
  label = 'Resize panes',
}) => {
  const draggingRef = useRef(false);

  const clamp = useCallback((r: number) => Math.min(maxRatio, Math.max(minRatio, r)), [minRatio, maxRatio]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const rect = container.getBoundingClientRect();
      const r =
        orientation === 'vertical'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      onChange(clamp(r));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(minRatio * 100)}
      aria-valuemax={Math.round(maxRatio * 100)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onChange(0.5)}
      onKeyDown={(e) => {
        const isVertical = orientation === 'vertical';
        const decreaseKey = isVertical ? 'ArrowLeft' : 'ArrowUp';
        const increaseKey = isVertical ? 'ArrowRight' : 'ArrowDown';
        if (e.ctrlKey && e.altKey && (e.key === decreaseKey || e.key === increaseKey)) {
          e.preventDefault();
          onChange(clamp(ratio + (e.key === increaseKey ? NUDGE_STEP : -NUDGE_STEP)));
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange(0.5);
        }
      }}
      className={
        'group shrink-0 touch-none select-none ' +
        (orientation === 'vertical'
          ? 'w-1.5 cursor-col-resize'
          : 'h-1.5 cursor-row-resize')
      }
    >
      <div
        className={
          'bg-divider transition-colors group-hover:bg-sky-500/60 group-focus-visible:bg-sky-500/60 ' +
          (orientation === 'vertical' ? 'mx-auto h-full w-px' : 'my-auto h-px w-full')
        }
      />
    </div>
  );
};

export default SplitDivider;
