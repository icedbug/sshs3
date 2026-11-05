// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { K8sPodDetailModal } from '../../src/renderer/src/components/K8s/K8sPodDetailModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';

describe('K8sPodDetailModal tabs', () => {
  beforeEach(() => {
    // The pod never loads: the tab strip must be usable while it is still loading.
    window.multissh = { k8sDescribePod: vi.fn(() => new Promise(() => undefined)) } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <K8sPodDetailModal contextName="minikube" namespace="default" podName="api-1" onClose={vi.fn()} />
      </ConfirmProvider>
    );
  });
  afterEach(() => cleanup());

  it('is a named tablist with one selected tab and one panel that the selected tab names', () => {
    const tablist = screen.getByRole('tablist', { name: 'Pod details' });
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent?.trim().replace(/\s+/g, ' '))).toEqual([
      'Overview',
      'Containers (0)',
      'Events (0)',
      'YAML',
    ]);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    // Roving tabindex: only the selected tab is a Tab stop.
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);

    const panel = screen.getByRole('tabpanel', { name: 'Overview' });
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-controls', panel.id);
  });

  it('moves between tabs with the arrow keys, Home and End, selecting the one it lands on', () => {
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();

    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const containers = screen.getByRole('tab', { name: /^Containers/ });
    expect(containers).toHaveFocus();
    expect(containers).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: /^Containers/ })).toBeInTheDocument();

    fireEvent.keyDown(containers, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'YAML' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'YAML' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });
});
