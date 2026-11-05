// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DiskSpaceMenu } from '../../src/renderer/src/components/FileManager/DiskSpaceMenu';

const GB = 1024 ** 3;

describe('DiskSpaceMenu', () => {
  beforeEach(() => {
    (window as any).multissh = {
      storageGetSpace: vi.fn().mockResolvedValue({ totalBytes: 100 * GB, freeBytes: 25 * GB }),
      storageListVolumes: vi.fn().mockResolvedValue([
        { path: 'C:\\', label: 'C:', totalBytes: 500 * GB, freeBytes: 100 * GB },
        { path: 'D:\\', label: 'D:', totalBytes: 1000 * GB, freeBytes: 900 * GB },
      ]),
    };
  });

  it('shows free space for the current path', async () => {
    render(<DiskSpaceMenu providerId="local" canListVolumes currentPath="C:\\Users" onNavigate={vi.fn()} />);
    expect(await screen.findByText('25.0 GB free')).toBeInTheDocument();
  });

  it('lists drives with fill level and navigates to the chosen one', async () => {
    const onNavigate = vi.fn();
    render(<DiskSpaceMenu providerId="local" canListVolumes currentPath="C:\\Users" onNavigate={onNavigate} />);
    await screen.findByText('25.0 GB free');

    fireEvent.click(screen.getByRole('button', { name: 'Drives and volumes' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveClass('left-0');
    expect(menu).not.toHaveClass('right-0');
    expect(await screen.findByText('D:')).toBeInTheDocument();
    expect(screen.getByText('900.0 GB free of 1000.0 GB')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /D:/ }));
    expect(onNavigate).toHaveBeenCalledWith('D:\\');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('is a plain indicator without a menu for providers that cannot list volumes', async () => {
    render(<DiskSpaceMenu providerId="sftp-1" canListVolumes={false} currentPath="/srv" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disk space' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect((window as any).multissh.storageListVolumes).not.toHaveBeenCalled();
  });

  it('renders nothing when an SFTP server reports no space info', async () => {
    (window as any).multissh.storageGetSpace = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <DiskSpaceMenu providerId="sftp-1" canListVolumes={false} currentPath="/srv" onNavigate={vi.fn()} />
    );
    await waitFor(() => expect(window.multissh.storageGetSpace).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
