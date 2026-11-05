// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GitStatusMenu } from '../../src/renderer/src/components/FileManager/GitStatusMenu';
import type { GitRepoStatus } from '@shared/types/git';

describe('GitStatusMenu', () => {
  beforeEach(() => {
    (window as any).multissh = {
      openExternal: vi.fn(),
    };
  });

  const baseStatus: GitRepoStatus = {
    isRepo: true,
    branch: 'main',
    isClean: true,
    ahead: 1,
    behind: 2,
    modifiedCount: 0,
    untrackedCount: 0,
    remoteOriginUrl: 'https://github.com/example/repo.git',
  };

  it('renders nothing when git integration is disabled', () => {
    const { container } = render(
      <GitStatusMenu
        enabled={false}
        gitStatus={baseStatus}
        gitPulling={false}
        sourceType="local"
        currentPath="/test"
        onPull={vi.fn()}
        onCloneHere={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders clone icon button when not in a git repo', () => {
    const onCloneHere = vi.fn();
    render(
      <GitStatusMenu
        enabled={true}
        gitStatus={{ isRepo: false }}
        gitPulling={false}
        sourceType="local"
        currentPath="/test/folder"
        onPull={vi.fn()}
        onCloneHere={onCloneHere}
      />
    );
    const cloneBtn = screen.getByRole('button', { name: 'Git (Clone repository here...)' });
    expect(cloneBtn).toBeInTheDocument();
    fireEvent.click(cloneBtn);
    expect(onCloneHere).toHaveBeenCalledWith('/test/folder');
  });

  it('renders branch button and opens dropdown menu positioned with left-0', () => {
    const onPull = vi.fn();
    const onCloneHere = vi.fn();
    render(
      <GitStatusMenu
        enabled={true}
        gitStatus={baseStatus}
        gitPulling={false}
        sourceType="local"
        currentPath="/test/repo"
        onPull={onPull}
        onCloneHere={onCloneHere}
      />
    );

    const triggerBtn = screen.getByTitle(/Git: main/);
    expect(triggerBtn).toBeInTheDocument();
    expect(screen.queryByText('Git Pull')).not.toBeInTheDocument();

    fireEvent.click(triggerBtn);

    // Menu should be open
    const pullBtn = screen.getByRole('button', { name: /Git Pull/ });
    expect(pullBtn).toBeInTheDocument();

    // Verify container class has left-0 (not right-0, preventing left screen overflow)
    const dropdown = pullBtn.closest('.absolute');
    expect(dropdown).toHaveClass('left-0');
    expect(dropdown).not.toHaveClass('right-0');

    // Test Pull action
    fireEvent.click(pullBtn);
    expect(onPull).toHaveBeenCalled();
    expect(screen.queryByText('Git Pull')).not.toBeInTheDocument();
  });

  it('opens web repository URL when clicked in menu', () => {
    render(
      <GitStatusMenu
        enabled={true}
        gitStatus={baseStatus}
        gitPulling={false}
        sourceType="local"
        currentPath="/test/repo"
        onPull={vi.fn()}
        onCloneHere={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTitle(/Git: main/));
    const webBtn = screen.getByRole('button', { name: /Open in GitHub\/GitLab/ });
    fireEvent.click(webBtn);

    expect(window.multissh.openExternal).toHaveBeenCalledWith('https://github.com/example/repo');
  });

  it('closes dropdown on outside click', () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <GitStatusMenu
          enabled={true}
          gitStatus={baseStatus}
          gitPulling={false}
          sourceType="local"
          currentPath="/test/repo"
          onPull={vi.fn()}
          onCloneHere={vi.fn()}
        />
      </div>
    );

    fireEvent.click(screen.getByTitle(/Git: main/));
    expect(screen.getByText('Git Pull')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Git Pull')).not.toBeInTheDocument();
  });
});
