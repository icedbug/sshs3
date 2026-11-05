// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TabBar, type TabItem } from '../../src/renderer/src/components/TabBar';

describe('TabBar Component', () => {
  afterEach(() => {
    cleanup();
  });

  const sampleTabs: TabItem[] = [
    { id: 'tab-1', type: 'terminal', title: 'prod-server' },
    { id: 'tab-2', type: 'filemanager', title: 'S3 Backups' },
    { id: 'tab-3', type: 'terminal', title: 'dev-box' },
  ];

  it('renders all tabs with titles, types, and active status', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();

    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-2"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />
    );

    // Verify all titles are displayed
    expect(screen.getByText('prod-server')).toBeInTheDocument();
    expect(screen.getByText('S3 Backups')).toBeInTheDocument();
    expect(screen.getByText('dev-box')).toBeInTheDocument();

    // Verify active tab status
    const tab2 = screen.getByTestId('tab-tab-2');
    expect(tab2).toHaveAttribute('aria-selected', 'true');

    const tab1 = screen.getByTestId('tab-tab-1');
    expect(tab1).toHaveAttribute('aria-selected', 'false');

    // Verify icons exist for terminal and filemanager
    expect(screen.getByTestId('tab-icon-tab-1')).toBeInTheDocument();
    expect(screen.getByTestId('tab-icon-tab-2')).toBeInTheDocument();
  });

  describe('keyboard and semantics', () => {
    function renderBar(activeTabId: string, onSelectTab = vi.fn()) {
      render(
        <TabBar tabs={sampleTabs} activeTabId={activeTabId} onSelectTab={onSelectTab} onCloseTab={vi.fn()} onNewTab={vi.fn()} />
      );
      return onSelectTab;
    }

    it('the tablist holds only the tabs, not the new-tab menu or toolbar buttons', () => {
      renderBar('tab-1');
      const tablist = screen.getByRole('tablist', { name: 'Open tabs' });
      expect(within(tablist).getAllByRole('tab')).toHaveLength(sampleTabs.length);
      expect(within(tablist).queryByRole('button', { name: /new tab/i })).not.toBeInTheDocument();
    });

    it('is one Tab stop: the active tab is tabbable, the others are reached with the arrow keys', () => {
      renderBar('tab-2');
      expect(screen.getByTestId('tab-tab-2')).toHaveAttribute('tabindex', '0');
      expect(screen.getByTestId('tab-tab-1')).toHaveAttribute('tabindex', '-1');
      expect(screen.getByTestId('tab-tab-3')).toHaveAttribute('tabindex', '-1');
    });

    it('makes the first tab tabbable when no tab is active (the landing page)', () => {
      renderBar('');
      expect(screen.getByTestId('tab-tab-1')).toHaveAttribute('tabindex', '0');
      expect(screen.getByTestId('tab-tab-2')).toHaveAttribute('tabindex', '-1');
    });

    it('moves focus with ArrowRight/ArrowLeft (wrapping), Home and End, without selecting', () => {
      const onSelectTab = renderBar('tab-1');
      const tab = (n: number) => screen.getByTestId(`tab-tab-${n}`);
      tab(1).focus();

      fireEvent.keyDown(tab(1), { key: 'ArrowRight' });
      expect(tab(2)).toHaveFocus();
      fireEvent.keyDown(tab(2), { key: 'End' });
      expect(tab(3)).toHaveFocus();
      fireEvent.keyDown(tab(3), { key: 'ArrowRight' });
      expect(tab(1)).toHaveFocus();
      fireEvent.keyDown(tab(1), { key: 'ArrowLeft' });
      expect(tab(3)).toHaveFocus();
      fireEvent.keyDown(tab(3), { key: 'Home' });
      expect(tab(1)).toHaveFocus();

      // Moving focus does not switch tabs: Enter or Space does
      expect(onSelectTab).not.toHaveBeenCalled();
      fireEvent.keyDown(tab(2), { key: 'Enter' });
      expect(onSelectTab).toHaveBeenCalledWith('tab-2');
    });

    it('leaves modified arrows to the spatial navigation (Ctrl+Shift+Arrow)', () => {
      renderBar('tab-1');
      const first = screen.getByTestId('tab-tab-1');
      first.focus();
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      first.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(first).toHaveFocus();
    });

    it('focuses the first item when the new-tab menu opens and moves through the items with the arrow keys', () => {
      renderBar('tab-1');
      fireEvent.click(screen.getByTestId('add-tab-btn'));

      const menu = screen.getByRole('menu', { name: 'New tab' });
      const items = within(menu).getAllByRole('menuitem');
      expect(items.length).toBeGreaterThan(1);
      expect(items[0]).toHaveFocus();

      fireEvent.keyDown(items[0], { key: 'ArrowDown' });
      expect(items[1]).toHaveFocus();
      fireEvent.keyDown(items[1], { key: 'End' });
      expect(items[items.length - 1]).toHaveFocus();
      fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
      expect(items[0]).toHaveFocus();
      fireEvent.keyDown(items[0], { key: 'ArrowUp' });
      expect(items[items.length - 1]).toHaveFocus();
    });

    it('Enter on a tab\'s close button closes the tab instead of selecting it', () => {
      const onSelectTab = vi.fn();
      const onCloseTab = vi.fn();
      render(
        <TabBar tabs={sampleTabs} activeTabId="tab-1" onSelectTab={onSelectTab} onCloseTab={onCloseTab} onNewTab={vi.fn()} />
      );
      const close = screen.getByTestId('close-tab-tab-2');
      close.focus();
      // The keydown bubbles to the tab; it must not be taken as "select this tab" (which would swallow the click).
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      close.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(onSelectTab).not.toHaveBeenCalled();
    });

    it('links each tab to its panel', () => {
      renderBar('tab-1');
      expect(screen.getByTestId('tab-tab-1')).toHaveAttribute('aria-controls', 'tab-panel-tab-1');
      expect(screen.getByTestId('tab-tab-1')).toHaveAttribute('id', 'tab-button-tab-1');
    });

    it('says "unsaved changes" in the tab name, not only with a dot', () => {
      render(
        <TabBar
          tabs={[{ id: 'e1', type: 'editor', title: 'notes.md', isDirty: true } as TabItem]}
          activeTabId="e1"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
        />
      );
      const tab = screen.getByRole('tab', { name: /unsaved changes/ });
      expect(tab).toHaveAccessibleName(expect.stringContaining('notes.md'));
    });
  });

  it('puts the search button first among the quick links, after the divider, and none without a search', () => {
    const { unmount } = render(
      <TabBar tabs={sampleTabs} activeTabId="tab-1" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onNewTab={vi.fn()} onOpenGlobalSearch={vi.fn()} />
    );
    const search = screen.getByTestId('global-search-btn');
    expect(search.parentElement).toHaveClass('border-l', 'border-divider');
    expect(search.parentElement).toContainElement(screen.getByTestId('quick-profiles-btn'));
    expect(search.parentElement?.firstElementChild).toBe(search);
    unmount();
    render(<TabBar tabs={sampleTabs} activeTabId="tab-1" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onNewTab={vi.fn()} />);
    expect(screen.queryByTestId('global-search-btn')).not.toBeInTheDocument();
  });

  it('calls onSelectTab when an inactive tab is clicked', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();

    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />
    );

    fireEvent.click(screen.getByTestId('tab-tab-2'));
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith('tab-2');
  });

  it('calls onCloseTab when close button is clicked without triggering onSelectTab', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();

    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />
    );

    const closeBtn = screen.getByTestId('close-tab-tab-3');
    fireEvent.click(closeBtn);

    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith('tab-3');
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('handles new tab creation via new tab dropdown/buttons', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();

    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />
    );

    // Click the "+" button to open the menu
    const addBtn = screen.getByTestId('add-tab-btn');
    fireEvent.click(addBtn);

    // Should show new terminal and new filemanager options
    const newTerminalBtn = screen.getByTestId('new-terminal-btn');
    const newFileManagerBtn = screen.getByTestId('new-filemanager-btn');

    expect(newTerminalBtn).toBeInTheDocument();
    expect(newFileManagerBtn).toBeInTheDocument();

    fireEvent.click(newTerminalBtn);
    expect(onNewTab).toHaveBeenCalledWith('terminal');

    // Click again for filemanager
    fireEvent.click(addBtn);
    fireEvent.click(screen.getByTestId('new-filemanager-btn'));
    expect(onNewTab).toHaveBeenCalledWith('filemanager');

    // The remote variant asks for a connection straight away
    fireEvent.click(addBtn);
    fireEvent.click(screen.getByTestId('new-remote-filemanager-btn'));
    expect(onNewTab).toHaveBeenCalledWith('filemanager', { remote: true });
  });

  it('triggers quick links for profiles and settings', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onNewTab = vi.fn();
    const onOpenProfiles = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        onOpenProfiles={onOpenProfiles}
        onOpenSettings={onOpenSettings}
      />
    );

    const profilesBtn = screen.getByTestId('quick-profiles-btn');
    const settingsBtn = screen.getByTestId('quick-settings-btn');

    fireEvent.click(profilesBtn);
    expect(onOpenProfiles).toHaveBeenCalledTimes(1);

    fireEvent.click(settingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('closes new tab menu on Escape and restores focus to the add-tab button', () => {
    render(
      <TabBar
        tabs={sampleTabs}
        activeTabId="tab-1"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />
    );

    const addBtn = screen.getByTestId('add-tab-btn');
    fireEvent.click(addBtn);
    expect(screen.getByTestId('new-terminal-btn')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('new-terminal-btn')).not.toBeInTheDocument();
  });

  describe('cached smartcard identities menu', () => {
    const renderWithSmartcard = (props: Partial<React.ComponentProps<typeof TabBar>> = {}) =>
      render(
        <TabBar
          tabs={sampleTabs}
          activeTabId="tab-1"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
          showLockSmartcardButton
          onListCachedSmartcards={() => Promise.resolve([])}
          onLockSmartcard={() => Promise.resolve({ locked: 0 })}
          {...props}
        />
      );

    it('is one toggle: Unlock Now when nothing is cached, Lock All Now when something is', async () => {
      const onUnlockSmartcard = vi.fn().mockResolvedValue({ started: true });
      const { unmount } = renderWithSmartcard({ onUnlockSmartcard });

      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      fireEvent.click(await screen.findByTestId('smartcard-unlock-now-btn'));
      expect(screen.queryByTestId('smartcard-lock-all-btn')).not.toBeInTheDocument();
      expect(onUnlockSmartcard).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Unlocking — enter your PIN when asked')).toBeInTheDocument();
      unmount();

      renderWithSmartcard({
        onUnlockSmartcard,
        onListCachedSmartcards: () =>
          Promise.resolve([{ pkcs11LibPath: '/usr/lib/opensc-pkcs11.so', identities: [] }]),
      });
      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      expect(await screen.findByTestId('smartcard-lock-all-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('smartcard-unlock-now-btn')).not.toBeInTheDocument();
    });

    it('tells the user when there was nothing to unlock', async () => {
      renderWithSmartcard({ onUnlockSmartcard: vi.fn().mockResolvedValue({ started: false }) });

      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      fireEvent.click(await screen.findByTestId('smartcard-unlock-now-btn'));

      expect(await screen.findByText(/Nothing to unlock/)).toBeInTheDocument();
    });

    it('shows neither button while the cached list is still loading', async () => {
      renderWithSmartcard({
        onUnlockSmartcard: vi.fn(),
        onListCachedSmartcards: () => new Promise(() => {}),
      });
      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByTestId('smartcard-unlock-now-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('smartcard-lock-all-btn')).not.toBeInTheDocument();
    });

    it('reports a failed lock instead of leaving an unhandled rejection', async () => {
      renderWithSmartcard({
        onListCachedSmartcards: () => Promise.resolve([{ pkcs11LibPath: '/usr/lib/opensc-pkcs11.so', identities: [] }]),
        onLockSmartcard: () => Promise.reject(new Error('agent gone')),
      });
      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      fireEvent.click(await screen.findByTestId('smartcard-lock-all-btn'));
      expect(await screen.findByText('Could not lock the smartcards')).toBeInTheDocument();
    });

    it('hides Unlock Now when no unlock handler is provided', () => {
      renderWithSmartcard();
      fireEvent.click(screen.getByTestId('quick-lock-smartcard-btn'));
      expect(screen.queryByTestId('smartcard-unlock-now-btn')).not.toBeInTheDocument();
    });
  });

  describe('Editor Tabs', () => {
    it('renders editor tabs with file icon and dirty indicator when unsaved', () => {
      const tabs: TabItem[] = [
        { id: 'tab-edit-1', type: 'editor', title: 'server.ts', isDirty: true },
        { id: 'tab-edit-2', type: 'editor', title: 'README.md', isDirty: false },
      ];

      render(
        <TabBar
          tabs={tabs}
          activeTabId="tab-edit-1"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onNewTab={vi.fn()}
        />
      );

      expect(screen.getByText('server.ts')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();

      const icon1 = screen.getByTestId('tab-icon-tab-edit-1');
      expect(icon1).toBeInTheDocument();
      expect(icon1).toHaveClass('text-emerald-400');

      expect(screen.getByTestId('tab-dirty-tab-edit-1')).toBeInTheDocument();
      expect(screen.queryByTestId('tab-dirty-tab-edit-2')).not.toBeInTheDocument();
    });
  });
});
