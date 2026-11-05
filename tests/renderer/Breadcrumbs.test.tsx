// @vitest-environment jsdom
import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Breadcrumbs, type BreadcrumbsHandle } from '../../src/renderer/src/components/FileManager/Breadcrumbs';

describe('Breadcrumbs Component', () => {
  it('enters editing mode via the imperative startEditing handle, with the whole path selected (§25)', () => {
    const ref = createRef<BreadcrumbsHandle>();
    render(<Breadcrumbs ref={ref} currentPath="/var/log" onNavigate={vi.fn()} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    act(() => ref.current?.startEditing());

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('/var/log');
  });

  it('renders path segments and handles segment navigation', () => {
    const onNavigate = vi.fn();
    render(<Breadcrumbs currentPath="/home/alun/projects" onNavigate={onNavigate} />);

    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.getByText('alun')).toBeInTheDocument();
    expect(screen.getByText('projects')).toBeInTheDocument();

    fireEvent.click(screen.getByText('alun'));
    expect(onNavigate).toHaveBeenCalledWith('/home/alun');
  });

  it('enters inline editing mode on double click and commits on submit', () => {
    const onNavigate = vi.fn();
    render(<Breadcrumbs currentPath="/var/log" onNavigate={onNavigate} />);

    const container = screen.getByTitle(/Double-click to enter path/i);
    fireEvent.doubleClick(container);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('/var/log');

    fireEvent.change(input, { target: { value: '/etc/nginx' } });
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).toHaveBeenCalledWith('/etc/nginx');
  });

  it('acts as drop targets for breadcrumb segments', () => {
    const onDropToPath = vi.fn();
    render(
      <Breadcrumbs
        currentPath="/home/alun/downloads"
        onNavigate={vi.fn()}
        onDropToPath={onDropToPath}
      />
    );

    const homeButton = screen.getByText('home');
    const dragDataTransfer = { dropEffect: 'none' };

    fireEvent.dragOver(homeButton, { dataTransfer: dragDataTransfer });
    expect(dragDataTransfer.dropEffect).toBe('copy');
    expect(homeButton.className).toContain('ring-sky-400');

    fireEvent.drop(homeButton, { dataTransfer: dragDataTransfer });
    expect(onDropToPath).toHaveBeenCalledWith('/home', expect.anything());
  });

  it('delegates drop on breadcrumb container to currentPath', () => {
    const onDropToPath = vi.fn();
    render(
      <Breadcrumbs
        currentPath="/home/alun/downloads"
        onNavigate={vi.fn()}
        onDropToPath={onDropToPath}
      />
    );

    const container = screen.getByTitle(/Double-click to enter path/i);
    fireEvent.drop(container, { dataTransfer: { dropEffect: 'none' } });
    expect(onDropToPath).toHaveBeenCalledWith('/home/alun/downloads', expect.anything());
  });

  it('spring-loads ancestor path when hovered for 900ms during drag', () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    render(
      <Breadcrumbs
        currentPath="/home/alun/downloads"
        onNavigate={onNavigate}
      />
    );

    const homeButton = screen.getByText('home');
    fireEvent.dragOver(homeButton, { dataTransfer: { dropEffect: 'none' } });

    vi.advanceTimersByTime(500);
    expect(onNavigate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(450);
    expect(onNavigate).toHaveBeenCalledWith('/home');

    vi.useRealTimers();
  });
});
