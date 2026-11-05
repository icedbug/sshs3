// @vitest-environment jsdom
import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SplitDivider } from '../../src/renderer/src/components/ui/SplitDivider';

function Harness({ ratio, onChange }: { ratio: number; onChange: (r: number) => void }) {
  const containerRef = createRef<HTMLDivElement>();
  return (
    <div ref={containerRef} style={{ width: 200, height: 200 }}>
      <SplitDivider orientation="vertical" ratio={ratio} onChange={onChange} containerRef={containerRef} />
    </div>
  );
}

describe('SplitDivider', () => {
  it('resets to 0.5 on double-click', () => {
    const onChange = vi.fn();
    render(<Harness ratio={0.7} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('resets to 0.5 on Enter/Space', () => {
    const onChange = vi.fn();
    render(<Harness ratio={0.3} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('nudges by 5% with Ctrl+Alt+Arrow, clamped to [0.1, 0.9]', () => {
    const onChange = vi.fn();
    render(<Harness ratio={0.5} onChange={onChange} />);
    const divider = screen.getByRole('separator');

    fireEvent.keyDown(divider, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith(0.55);

    onChange.mockClear();
    fireEvent.keyDown(divider, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith(0.45);
  });

  it('does not nudge on a plain arrow key (no Ctrl+Alt)', () => {
    const onChange = vi.fn();
    render(<Harness ratio={0.5} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes its ratio via aria-valuenow for assistive tech', () => {
    render(<Harness ratio={0.65} onChange={vi.fn()} />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '65');
  });
});
