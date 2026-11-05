// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ClipboardHistoryModal } from '../../src/renderer/src/components/ClipboardHistoryModal';
import { SnippetPaletteModal } from '../../src/renderer/src/components/SnippetPaletteModal';
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal/SettingsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

// Clearing the clipboard history, deleting a snippet: neither can be undone, so each asks first.
describe('destructive actions ask for confirmation', () => {
  beforeAll(() => {
    // jsdom has no layout: the palettes scroll the active row into view.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => cleanup());

  async function answer(button: 'Cancel' | string) {
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: button }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  }

  it('Clipboard history > Clear all', async () => {
    const clipboardHistoryClear = vi.fn().mockResolvedValue(undefined);
    window.multissh = {
      clipboardHistoryList: vi.fn().mockResolvedValue([
        { id: 'a', text: 'ls -la', copiedAt: '2026-10-01T10:00:00Z', hostKey: 'h', hostLabel: 'host' },
        { id: 'b', text: 'pwd', copiedAt: '2026-10-01T10:01:00Z', hostKey: 'h', hostLabel: 'host' },
      ]),
      clipboardHistoryClear,
      clipboardHistoryDelete: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <ClipboardHistoryModal onPaste={vi.fn()} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.getByText('ls -la')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete all 2 entries from the clipboard history?');
    await answer('Cancel');
    expect(clipboardHistoryClear).not.toHaveBeenCalled();
    expect(screen.getByText('ls -la')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await answer('Clear history');
    expect(clipboardHistoryClear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('ls -la')).not.toBeInTheDocument());
  });

  it('Snippet palette > Delete snippet', async () => {
    const snippetsDelete = vi.fn().mockResolvedValue(undefined);
    window.multissh = {
      snippetsList: vi.fn().mockResolvedValue([{ id: 's1', name: 'Disk usage', command: 'df -h' }]),
      snippetsDelete,
    } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <SnippetPaletteModal
          hostKey="h"
          hostLabel="host"
          context={{ host: 'host', user: 'alice' }}
          onInsert={vi.fn()}
          onClose={vi.fn()}
        />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.getByText('Disk usage')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete snippet' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete the snippet "Disk usage"?');
    await answer('Cancel');
    expect(snippetsDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Disk usage')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete snippet' }));
    await answer('Delete snippet');
    expect(snippetsDelete).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.queryByText('Disk usage')).not.toBeInTheDocument());
  });

  it('Settings > Terminal > Clear history', async () => {
    const clipboardHistoryClear = vi.fn().mockResolvedValue(undefined);
    window.multissh = new Proxy(
      { clipboardHistoryClear },
      {
        get: (target: Record<string, unknown>, prop: string) => {
          if (prop in target) return target[prop];
          return /^on[A-Z]/.test(prop) ? vi.fn(() => () => undefined) : vi.fn().mockResolvedValue(undefined);
        },
      }
    ) as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <SettingsModal open currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await answer('Cancel');
    expect(clipboardHistoryClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await answer('Clear history');
    expect(clipboardHistoryClear).toHaveBeenCalledTimes(1);
  });

  it('Clipboard history exposes the active entry and the result count to assistive technology', async () => {
    window.multissh = {
      clipboardHistoryList: vi.fn().mockResolvedValue([
        { id: 'a', text: 'ls -la', copiedAt: '2026-10-01T10:00:00Z', hostKey: 'h', hostLabel: 'host' },
        { id: 'b', text: 'pwd', copiedAt: '2026-10-01T10:01:00Z', hostKey: 'h', hostLabel: 'host' },
      ]),
    } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <ClipboardHistoryModal onPaste={vi.fn()} onClose={vi.fn()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.getByText('ls -la')).toBeInTheDocument());

    const search = screen.getByRole('textbox', { name: 'Search clipboard history' });
    expect(search).toHaveAttribute('aria-controls', 'clipboard-history-list');
    expect(search).toHaveAttribute('aria-activedescendant', 'clipboard-history-item-0');
    expect(screen.getByRole('status')).toHaveTextContent('2 entries');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'clipboard-history-item-1');
    expect(document.getElementById('clipboard-history-item-1')).toHaveAttribute('aria-current', 'true');
    expect(document.getElementById('clipboard-history-item-0')).not.toHaveAttribute('aria-current');
  });
});

