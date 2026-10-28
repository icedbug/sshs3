// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TeamProfileTree } from '../../src/renderer/src/components/ConnectionModal/TeamProfileTree';
import { buildTeamFolderTree } from '../../src/renderer/src/components/ConnectionModal/teamProfileTreeModel';

interface P {
  id: string;
  name: string;
  group?: string;
}

type TreeProps = Parameters<typeof TeamProfileTree<P>>[0];

/** Manages `currentPath` as real state (like `ConnectionManagerModal` does) so clicking a card
 * or breadcrumb segment actually navigates, instead of requiring the test to manually re-render
 * with a new `currentPath` prop every time. */
function Harness(props: Omit<TreeProps, 'currentPath' | 'onNavigate'> & { initialPath?: string[] }) {
  const [path, setPath] = useState<string[]>(props.initialPath ?? []);
  return <TeamProfileTree {...props} currentPath={path} onNavigate={setPath} />;
}

function renderTree(
  folders: string[],
  profiles: P[],
  overrides: Partial<TreeProps> & { initialPath?: string[] } = {},
  folderIcons: Record<string, string> = {}
) {
  const { roots, ungrouped } = buildTeamFolderTree(folders, profiles, folderIcons);
  const onDropProfile = vi.fn();
  const onCreateFolder = vi.fn();
  const onRenameFolder = vi.fn();
  const onDeleteFolder = vi.fn();
  const onSetFolderIcon = vi.fn();
  const utils = render(
    <Harness
      roots={roots}
      ungrouped={ungrouped}
      query=""
      renderProfile={(p) => <div key={p.id}>{p.name}</div>}
      onDropProfile={onDropProfile}
      onCreateFolder={onCreateFolder}
      onRenameFolder={onRenameFolder}
      onDeleteFolder={onDeleteFolder}
      onSetFolderIcon={onSetFolderIcon}
      {...overrides}
    />
  );
  return { ...utils, onDropProfile, onCreateFolder, onRenameFolder, onDeleteFolder, onSetFolderIcon };
}

/** The card for a folder path, via the stable `data-folder-path` attribute set on its container
 * (not derived from any button title, which can be ambiguous or change). */
function getCard(path: string): HTMLElement {
  return document.querySelector(`[data-folder-path="${path}"]`) as HTMLElement;
}

describe('TeamProfileTree', () => {
  afterEach(() => cleanup());

  it('shows top-level folders as cards, not their nested contents', () => {
    const profiles: P[] = [
      { id: 'p1', name: 'web-1', group: 'Acme Infra' },
      { id: 'p2', name: 'node-1', group: 'Acme Infra/Cluster A' },
    ];
    renderTree(['Acme Infra', 'Acme Infra/Cluster A'], profiles);

    expect(screen.getByText('Acme Infra')).toBeInTheDocument();
    expect(screen.queryByText('Cluster A')).not.toBeInTheDocument();
    expect(screen.queryByText('web-1')).not.toBeInTheDocument();
    expect(screen.queryByText('node-1')).not.toBeInTheDocument();
  });

  it('shows an ungrouped section at the top level for profiles without a group', () => {
    renderTree([], [{ id: 'p1', name: 'standalone' }]);
    expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    expect(screen.getByText('standalone')).toBeInTheDocument();
  });

  it('clicking into a folder card shows a breadcrumb and that folder\'s profiles/subfolders', () => {
    const profiles: P[] = [
      { id: 'p1', name: 'web-1', group: 'Acme Infra' },
      { id: 'p2', name: 'node-1', group: 'Acme Infra/Cluster A' },
    ];
    renderTree(['Acme Infra', 'Acme Infra/Cluster A'], profiles);

    fireEvent.click(screen.getByText('Acme Infra'));

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All folders' })).toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
    expect(screen.getByText('Cluster A')).toBeInTheDocument();
    expect(screen.queryByText('node-1')).not.toBeInTheDocument();
  });

  it('clicking anywhere on the card container (upper or lower area) opens the folder', () => {
    renderTree(['Acme Infra'], [{ id: 'p1', name: 'web-1', group: 'Acme Infra' }]);

    // Click directly on the outer card container (not the inner text)
    fireEvent.click(getCard('Acme Infra'));

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
  });

  it('pressing Enter on the card container opens the folder', () => {
    renderTree(['Acme Infra'], [{ id: 'p1', name: 'web-1', group: 'Acme Infra' }]);

    const card = getCard('Acme Infra');
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
  });

  it('"Back" returns to the top level', () => {
    renderTree(['Acme Infra'], [{ id: 'p1', name: 'web-1', group: 'Acme Infra' }]);

    fireEvent.click(screen.getByText('Acme Infra'));
    expect(screen.getByText('web-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByText('web-1')).not.toBeInTheDocument();
    expect(screen.getByText('Acme Infra')).toBeInTheDocument();
  });

  it('creating a top-level folder calls onCreateFolder with the typed name', () => {
    const { onCreateFolder } = renderTree([], []);

    fireEvent.click(screen.getByRole('button', { name: /New top-level folder/i }));
    const input = screen.getByPlaceholderText('Folder name');
    fireEvent.change(input, { target: { value: 'New System' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCreateFolder).toHaveBeenCalledWith('New System');
  });

  it('creating a subfolder while drilled in calls onCreateFolder with the joined path', () => {
    const { onCreateFolder } = renderTree(['Acme Infra'], []);

    fireEvent.click(screen.getByText('Acme Infra'));
    fireEvent.click(screen.getByRole('button', { name: /New subfolder/i }));
    const input = screen.getByPlaceholderText('Folder name');
    fireEvent.change(input, { target: { value: 'Cluster A' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCreateFolder).toHaveBeenCalledWith('Acme Infra/Cluster A');
  });

  it('renaming a folder card calls onRenameFolder with the old and new full paths', () => {
    const { onRenameFolder } = renderTree(['Acme Infra/Cluster A'], [], { initialPath: ['Acme Infra'] });

    const card = getCard('Acme Infra/Cluster A');
    fireEvent.click(within(card).getByTitle('Rename folder'));
    const input = screen.getByDisplayValue('Cluster A');
    fireEvent.change(input, { target: { value: 'Cluster B' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameFolder).toHaveBeenCalledWith('Acme Infra/Cluster A', 'Acme Infra/Cluster B');
  });

  it('falls back to the default folder icon for an unrecognized icon key, including prototype-polluting ones, instead of crashing', () => {
    // `folderIcons` comes from the synced, decrypted vault payload — written by whichever
    // member's client last touched the folder. This app's own IPC handler validates against
    // TEAM_FOLDER_ICONS before writing, but that's only a write-time check on this app's own
    // save path; a different (or tampered) client could still have written anything. A naive
    // `FOLDER_ICON_COMPONENTS[icon]` plain-object lookup would resolve "constructor"/"__proto__"
    // through Object.prototype instead of returning undefined, handing back a non-component
    // value that crashes the render the moment React tries to use it as one.
    for (const maliciousKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'not-a-real-icon']) {
      expect(() => renderTree(['Acme Infra'], [], {}, { 'Acme Infra': maliciousKey })).not.toThrow();
      cleanup();
    }
    renderTree(['Acme Infra'], [], {}, { 'Acme Infra': '__proto__' });
    expect(screen.getByText('Acme Infra')).toBeInTheDocument();
  });

  it('clicking the folder icon opens an icon picker, and choosing one calls onSetFolderIcon', () => {
    const { onSetFolderIcon } = renderTree(['Acme Infra'], []);

    fireEvent.click(screen.getByTitle('Change folder icon'));
    fireEvent.click(screen.getByTitle('server'));

    expect(onSetFolderIcon).toHaveBeenCalledWith('Acme Infra', 'server');
  });

  it('choosing the default (folder) icon clears it by passing undefined', () => {
    const { onSetFolderIcon } = renderTree(['Acme Infra'], [], {}, { 'Acme Infra': 'server' });

    fireEvent.click(screen.getByTitle('Change folder icon'));
    fireEvent.click(screen.getByTitle('folder'));

    expect(onSetFolderIcon).toHaveBeenCalledWith('Acme Infra', undefined);
  });

  it('clicking the backdrop closes an open icon picker without calling onSetFolderIcon', () => {
    const { onSetFolderIcon } = renderTree(['Acme Infra'], []);

    fireEvent.click(screen.getByTitle('Change folder icon'));
    expect(screen.getByTitle('server')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('icon-picker-backdrop'));

    expect(screen.queryByTitle('server')).not.toBeInTheDocument();
    expect(onSetFolderIcon).not.toHaveBeenCalled();
  });

  it('deleting a folder card calls onDeleteFolder with its full path', () => {
    const { onDeleteFolder } = renderTree(['Acme Infra'], []);

    fireEvent.click(screen.getByTitle(/Delete folder/));
    expect(onDeleteFolder).toHaveBeenCalledWith('Acme Infra');
  });

  it('dropping a profile on a folder card calls onDropProfile with that folder path', () => {
    const { onDropProfile } = renderTree(['Acme Infra'], []);
    const card = getCard('Acme Infra');

    const dataTransfer = { getData: () => JSON.stringify({ type: 'ssh', id: 'p1' }) };
    fireEvent.drop(card, { dataTransfer });

    expect(onDropProfile).toHaveBeenCalledWith('Acme Infra', expect.anything());
  });

  it('dropping a profile on an ancestor breadcrumb crumb calls onDropProfile with that ancestor path', () => {
    const { onDropProfile } = renderTree(['Acme Infra/Cluster A/Node 1'], [], { initialPath: ['Acme Infra', 'Cluster A', 'Node 1'] });

    const dataTransfer = { getData: () => JSON.stringify({ type: 'ssh', id: 'p1' }) };
    fireEvent.drop(screen.getByRole('button', { name: 'Acme Infra' }), { dataTransfer });

    expect(onDropProfile).toHaveBeenCalledWith('Acme Infra', expect.anything());
  });

  it('dropping a profile on the Ungrouped zone calls onDropProfile with undefined', () => {
    const { onDropProfile } = renderTree([], [{ id: 'p1', name: 'standalone' }]);
    const zone = screen.getByText('Ungrouped').parentElement!;

    const dataTransfer = { getData: () => JSON.stringify({ type: 'ssh', id: 'p1' }) };
    fireEvent.drop(zone, { dataTransfer });

    expect(onDropProfile).toHaveBeenCalledWith(undefined, expect.anything());
  });

  describe('search mode', () => {
    it('shows a flat, path-labeled list of matches regardless of currentPath, with no card grid', () => {
      const profiles: P[] = [{ id: 'p1', name: 'web-1', group: 'Acme Infra/Cluster A' }];
      renderTree(['Acme Infra', 'Acme Infra/Cluster A'], profiles, { query: 'web' });

      expect(screen.getByText(/Search results for/)).toBeInTheDocument();
      expect(screen.getByText('web-1')).toBeInTheDocument();
      expect(screen.getByText('Acme Infra/Cluster A')).toBeInTheDocument();
      expect(screen.queryByTitle('Open Acme Infra')).not.toBeInTheDocument();
    });

    it('labels an ungrouped match as "Ungrouped"', () => {
      renderTree([], [{ id: 'p1', name: 'standalone' }], { query: 'stand' });
      expect(screen.getByText('standalone')).toBeInTheDocument();
      expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    });

    it('shows "No matches" when nothing matches', () => {
      renderTree([], [], { query: 'nothing' });
      expect(screen.getByText('No matches')).toBeInTheDocument();
    });

    it('preserves currentPath in the background: clearing the query returns to where the user was', () => {
      const profiles: P[] = [{ id: 'p1', name: 'web-1', group: 'Acme Infra' }];
      const { rerender } = renderTree(['Acme Infra'], profiles, { initialPath: ['Acme Infra'], query: '' });
      expect(screen.getByText('web-1')).toBeInTheDocument();

      const { roots, ungrouped } = buildTeamFolderTree(['Acme Infra'], profiles);
      rerender(
        <Harness
          roots={roots}
          ungrouped={ungrouped}
          initialPath={['Acme Infra']}
          query="web"
          renderProfile={(p) => <div key={p.id}>{p.name}</div>}
          onDropProfile={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFolder={vi.fn()}
          onDeleteFolder={vi.fn()}
          onSetFolderIcon={vi.fn()}
        />
      );
      expect(screen.getByText(/Search results for/)).toBeInTheDocument();

      rerender(
        <Harness
          roots={roots}
          ungrouped={ungrouped}
          initialPath={['Acme Infra']}
          query=""
          renderProfile={(p) => <div key={p.id}>{p.name}</div>}
          onDropProfile={vi.fn()}
          onCreateFolder={vi.fn()}
          onRenameFolder={vi.fn()}
          onDeleteFolder={vi.fn()}
          onSetFolderIcon={vi.fn()}
        />
      );
      // Harness remounts its own state from `initialPath` on every rerender here (it's not a
      // real app re-render path), so this only proves the component itself doesn't reset
      // `currentPath` as a side effect of the query changing — the real "state survives" guarantee
      // comes from `currentPath` being owned by the parent (ConnectionManagerModal), not this
      // component, which the prop-driven design here enforces structurally.
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByText('web-1')).toBeInTheDocument();
    });
  });
});
