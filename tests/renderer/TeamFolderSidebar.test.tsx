// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TeamFolderSidebar } from '../../src/renderer/src/components/ConnectionModal/TeamFolderSidebar';
import { buildTeamFolderTree } from '../../src/renderer/src/components/ConnectionModal/teamFolderTree';

afterEach(cleanup);

interface P {
  id: string;
  group?: string;
}

const profiles: P[] = [
  { id: '1', group: 'Acme' },
  { id: '2', group: 'Acme/Prod' },
  { id: '3', group: 'Acme/Prod' },
  { id: '4', group: 'Acme/Prod/Web' },
  { id: '5', group: 'Staging' },
  { id: '6' },
];
const folders = ['Acme', 'Acme/Prod', 'Acme/Prod/Web', 'Staging', 'Empty'];

function Harness({ initialPath = [], onDropProfile }: { initialPath?: string[]; onDropProfile: (p: string | undefined, e: React.DragEvent) => void }) {
  const [path, setPath] = useState(initialPath);
  const { roots, ungrouped } = buildTeamFolderTree(folders, profiles, {});
  return (
    <TeamFolderSidebar roots={roots} ungroupedCount={ungrouped.length} currentPath={path} onNavigate={setPath} onDropProfile={onDropProfile} />
  );
}

function renderSidebar(initialPath: string[] = []) {
  const onDropProfile = vi.fn();
  render(<Harness initialPath={initialPath} onDropProfile={onDropProfile} />);
  return { onDropProfile, nav: screen.getByRole('navigation', { name: 'Folders' }) };
}

const folderButton = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });

describe('TeamFolderSidebar', () => {
  it('lists "All folders" with the total number of profiles, and the top-level folders with theirs', () => {
    const { nav } = renderSidebar();
    expect(within(nav).getByRole('button', { name: /^All folders/ })).toHaveTextContent('6');
    expect(folderButton('Acme')).toHaveTextContent('4');
    expect(folderButton('Staging')).toHaveTextContent('1');
    expect(folderButton('Empty')).toHaveTextContent('0');
  });

  it('keeps subfolders hidden until their parent is expanded', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /^Prod\b/ })).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand Acme' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(folderButton('Prod')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Acme' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Acme' }));
    expect(screen.queryByRole('button', { name: /^Prod\b/ })).not.toBeInTheDocument();
  });

  it('only offers an expander for folders that have subfolders', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Expand Staging' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand Empty' })).not.toBeInTheDocument();
  });

  it('shows the current folder, with every folder above it opened', () => {
    renderSidebar(['Acme', 'Prod', 'Web']);
    expect(folderButton('Web')).toHaveAttribute('aria-current', 'page');
    expect(folderButton('Prod')).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Collapse Acme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Prod' })).toBeInTheDocument();
  });

  it('marks All folders as current at the root', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /^All folders/ })).toHaveAttribute('aria-current', 'page');
  });

  it('navigates to the full path of the folder that was clicked, and back to the root', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Acme' }));
    fireEvent.click(folderButton('Prod'));
    expect(folderButton('Prod')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: /^All folders/ }));
    expect(screen.getByRole('button', { name: /^All folders/ })).toHaveAttribute('aria-current', 'page');
    expect(folderButton('Prod')).not.toHaveAttribute('aria-current');
  });

  it('keeps the folders the user opened open when another folder is chosen', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Acme' }));
    fireEvent.click(folderButton('Staging'));
    expect(folderButton('Staging')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Collapse Acme' })).toBeInTheDocument();
    expect(folderButton('Prod')).toBeInTheDocument();
  });

  it('opens the folders above the current one when the path changes from outside', () => {
    function Outside() {
      const [path, setPath] = useState<string[]>([]);
      const { roots, ungrouped } = buildTeamFolderTree(folders, profiles, {});
      return (
        <>
          <button onClick={() => setPath(['Acme', 'Prod', 'Web'])}>jump</button>
          <TeamFolderSidebar roots={roots} ungroupedCount={ungrouped.length} currentPath={path} onNavigate={setPath} onDropProfile={vi.fn()} />
        </>
      );
    }
    render(<Outside />);
    expect(screen.queryByRole('button', { name: /^Web\b/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('jump'));
    expect(folderButton('Web')).toHaveAttribute('aria-current', 'page');
  });

  it('moves a dropped profile into the folder it is dropped on, and out of any folder when dropped on All folders', () => {
    const { onDropProfile } = renderSidebar();
    fireEvent.drop(folderButton('Staging'));
    expect(onDropProfile).toHaveBeenLastCalledWith('Staging', expect.anything());
    fireEvent.drop(screen.getByRole('button', { name: /^All folders/ }));
    expect(onDropProfile).toHaveBeenLastCalledWith(undefined, expect.anything());
  });

  it('accepts a drag over a folder (so the browser allows the drop)', () => {
    renderSidebar();
    const notPrevented = fireEvent.dragOver(folderButton('Staging'), { dataTransfer: { dropEffect: 'none' } });
    expect(notPrevented).toBe(false);
  });

  it('shows only "All folders" for a vault without folders', () => {
    const onDropProfile = vi.fn();
    const { roots, ungrouped } = buildTeamFolderTree([], [{ id: 'x' }] as P[], {});
    render(<TeamFolderSidebar roots={roots} ungroupedCount={ungrouped.length} currentPath={[]} onNavigate={vi.fn()} onDropProfile={onDropProfile} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^All folders/ })).toHaveTextContent('1');
  });
});
