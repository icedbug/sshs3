// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GlobalSearchButton } from '../../src/renderer/src/components/GlobalSearchButton';

afterEach(cleanup);

describe('GlobalSearchButton', () => {
  it('opens the search when clicked', () => {
    const onOpen = vi.fn();
    render(<GlobalSearchButton onOpen={onOpen} shortcuts={undefined} />);
    fireEvent.click(screen.getByTestId('global-search-btn'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is named for assistive technology and shows the default shortcut in its tooltip', () => {
    render(<GlobalSearchButton onOpen={vi.fn()} shortcuts={undefined} />);
    const button = screen.getByRole('button', { name: 'Search profiles, tabs and hosts' });
    expect(button).toHaveAttribute('title', 'Search profiles, tabs and hosts (Ctrl+Shift+G)');
  });

  it('shows the shortcut the user has chosen', () => {
    render(<GlobalSearchButton onOpen={vi.fn()} shortcuts={{ globalSearch: 'Ctrl+Alt+P' }} />);
    expect(screen.getByTestId('global-search-btn')).toHaveAttribute('title', expect.stringContaining('Ctrl+Alt+P'));
  });

  it('is an icon button like the quick links beside it, not drawn as a text field', () => {
    render(<GlobalSearchButton onOpen={vi.fn()} shortcuts={undefined} />);
    const button = screen.getByTestId('global-search-btn');
    expect(button.textContent).toBe('');
    expect(button).toHaveClass('h-6', 'w-6', 'hover:bg-app-surface-hover');
    expect(button).not.toHaveClass('border');
    expect(button).not.toHaveClass('bg-app-input');
  });
});
