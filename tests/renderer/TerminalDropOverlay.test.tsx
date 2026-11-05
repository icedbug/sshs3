// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalDropOverlay } from '../../src/renderer/src/components/TerminalDropOverlay';

describe('TerminalDropOverlay', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when isDragging is false', () => {
    const { container } = render(
      <TerminalDropOverlay
        isDragging={false}
        isRemote={true}
        targetFolder="/var/www/html"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders remote upload overlay with destination folder', () => {
    render(
      <TerminalDropOverlay
        isDragging={true}
        isRemote={true}
        targetFolder="/var/www/html"
      />
    );

    expect(screen.getByTestId('terminal-drop-overlay')).toBeInTheDocument();
    expect(screen.getByText('Drop to Upload & Paste Path')).toBeInTheDocument();
    expect(screen.getByText('/var/www/html')).toBeInTheDocument();
  });

  it('renders local file paste overlay for local sessions', () => {
    render(
      <TerminalDropOverlay
        isDragging={true}
        isRemote={false}
        targetFolder="/home/user"
      />
    );

    expect(screen.getByTestId('terminal-drop-overlay')).toBeInTheDocument();
    expect(screen.getByText('Drop to Paste File Path')).toBeInTheDocument();
  });
});
