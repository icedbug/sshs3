// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TabBar, type TabItem } from '../../src/renderer/src/components/TabBar';
import { openTabMenuFor } from '../../src/renderer/src/lib/tabMenuEvents';

const tabs: TabItem[] = [
  { id: 't1', type: 'terminal', title: 'prod' },
  { id: 'e1', type: 'editor', title: 'notes.txt', isDirty: true },
];
const windows = [
  { id: 1, label: 'Window 1', current: true },
  { id: 2, label: 'Window 2', current: false },
];

function setup() {
  const onMoveTab = vi.fn();
  render(
    <TabBar
      tabs={tabs}
      activeTabId="t1"
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onNewTab={vi.fn()}
      onMoveTab={onMoveTab}
      onListWindows={() => Promise.resolve(windows)}
    />
  );
  return { onMoveTab };
}

describe('Tab context menu', () => {
  afterEach(cleanup);

  it('offers a new window and every other window, but not the current one', async () => {
    setup();
    fireEvent.contextMenu(screen.getByTestId('tab-t1'), { clientX: 20, clientY: 20 });

    expect(await screen.findByTestId('tab-move-new-window')).toBeEnabled();
    expect(screen.getByText('Move to Window 2')).toBeInTheDocument();
    expect(screen.queryByText('Move to Window 1')).not.toBeInTheDocument();
  });

  it('moves the tab to the chosen target and closes the menu', async () => {
    const { onMoveTab } = setup();
    fireEvent.contextMenu(screen.getByTestId('tab-t1'));
    fireEvent.click(await screen.findByTestId('tab-move-window-2'));

    expect(onMoveTab).toHaveBeenCalledWith('t1', 2);
    expect(screen.queryByTestId('tab-context-menu')).not.toBeInTheDocument();
  });

  it('opens from the keyboard and closes on Escape', async () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('tab-t1'), { key: 'ContextMenu' });
    const menu = await screen.findByTestId('tab-context-menu');

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('tab-context-menu')).not.toBeInTheDocument());
  });

  it('disables moving a tab with unsaved changes and does not let it be dragged', async () => {
    const { onMoveTab } = setup();
    expect(screen.getByTestId('tab-e1')).toHaveAttribute('draggable', 'false');
    fireEvent.contextMenu(screen.getByTestId('tab-e1'));

    const item = await screen.findByTestId('tab-move-new-window');
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onMoveTab).not.toHaveBeenCalled();
  });

  it('opens the menu of the given tab from the Tab Actions shortcut event', async () => {
    const { onMoveTab } = setup();
    openTabMenuFor('t1');
    fireEvent.click(await screen.findByTestId('tab-move-window-2'));
    expect(onMoveTab).toHaveBeenCalledWith('t1', 2);
  });
});
