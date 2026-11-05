// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePortDetection } from '../../src/renderer/src/lib/usePortDetection';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

describe('usePortDetection', () => {
  const sampleConfig: SSHConnectionConfig = {
    id: 'ssh-1',
    name: 'Web Host',
    host: 'web.example.com',
    port: 22,
    username: 'user',
    authType: 'password',
  };

  beforeEach(() => {
    window.multissh = {
      ...(window.multissh || {}),
      openExternal: vi.fn().mockResolvedValue(undefined),
      sshTunnelCheckPort: vi.fn().mockResolvedValue(true),
      sshTunnelStart: vi.fn().mockResolvedValue({ id: 'active-tunnel-1', status: 'active' }),
      sshTunnelStop: vi.fn().mockResolvedValue(true),
    } as any;
  });

  it('scans output and detects listening ports', () => {
    const { result } = renderHook(() =>
      usePortDetection({
        enabled: true,
        isRemote: true,
        config: sampleConfig,
      })
    );

    expect(result.current.detectedPorts).toEqual([]);

    act(() => {
      result.current.scanOutput('Server listening on http://localhost:8080');
    });

    expect(result.current.detectedPorts).toHaveLength(1);
    expect(result.current.detectedPorts[0].port).toBe(8080);
    expect(result.current.detectedPorts[0].protocol).toBe('http');
  });

  it('dismisses a port and prevents it from re-appearing', () => {
    const { result } = renderHook(() =>
      usePortDetection({
        enabled: true,
        isRemote: true,
        config: sampleConfig,
      })
    );

    act(() => {
      result.current.scanOutput('Listening on http://localhost:3000');
    });

    expect(result.current.detectedPorts).toHaveLength(1);

    act(() => {
      result.current.dismissPort(3000);
    });

    expect(result.current.detectedPorts).toHaveLength(0);

    // Scan again with same port — should be ignored because it was dismissed
    act(() => {
      result.current.scanOutput('Listening on http://localhost:3000');
    });

    expect(result.current.detectedPorts).toHaveLength(0);
  });

  it('clears detected ports when enabled becomes false', () => {
    let enabled = true;
    const { result, rerender } = renderHook(() =>
      usePortDetection({
        enabled,
        isRemote: true,
        config: sampleConfig,
      })
    );

    act(() => {
      result.current.scanOutput('Listening on http://localhost:5000');
    });

    expect(result.current.detectedPorts).toHaveLength(1);

    enabled = false;
    rerender();

    expect(result.current.detectedPorts).toHaveLength(0);
  });

  it('directly opens browser for local sessions', async () => {
    const { result } = renderHook(() =>
      usePortDetection({
        enabled: true,
        isRemote: false,
      })
    );

    await act(async () => {
      await result.current.handleForwardAndOpen(3000, 'http');
    });

    expect(window.multissh.openExternal).toHaveBeenCalledWith('http://localhost:3000');
    expect(window.multissh.sshTunnelStart).not.toHaveBeenCalled();
  });

  it('starts SSH tunnel and opens browser for remote SSH sessions', async () => {
    const { result } = renderHook(() =>
      usePortDetection({
        enabled: true,
        isRemote: true,
        config: sampleConfig,
      })
    );

    await act(async () => {
      await result.current.handleForwardAndOpen(8080, 'http');
    });

    expect(window.multissh.sshTunnelCheckPort).toHaveBeenCalledWith(8080);
    expect(window.multissh.sshTunnelStart).toHaveBeenCalledWith(
      sampleConfig,
      expect.objectContaining({
        type: 'local',
        localPort: 8080,
        remoteHost: '127.0.0.1',
        remotePort: 8080,
      })
    );
    expect(window.multissh.openExternal).toHaveBeenCalledWith('http://localhost:8080');
  });

  it('finds alternative local port if preferred port is already bound', async () => {
    window.multissh.sshTunnelCheckPort = vi
      .fn()
      .mockResolvedValueOnce(false) // 8080 taken
      .mockResolvedValueOnce(true); // 9080 free

    const { result } = renderHook(() =>
      usePortDetection({
        enabled: true,
        isRemote: true,
        config: sampleConfig,
      })
    );

    await act(async () => {
      await result.current.handleForwardAndOpen(8080, 'http');
    });

    expect(window.multissh.sshTunnelStart).toHaveBeenCalledWith(
      sampleConfig,
      expect.objectContaining({
        type: 'local',
        localPort: 9080,
        remoteHost: '127.0.0.1',
        remotePort: 8080,
      })
    );
    expect(window.multissh.openExternal).toHaveBeenCalledWith('http://localhost:9080');
  });

  it('reopens the forwarded local port, not the remote one, when the tunnel already exists', async () => {
    window.multissh.sshTunnelCheckPort = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePortDetection({ enabled: true, isRemote: true, config: sampleConfig }));

    await act(async () => {
      await result.current.handleForwardAndOpen(8080, 'http');
    });
    await act(async () => {
      await result.current.handleForwardAndOpen(8080, 'http');
    });

    expect(window.multissh.sshTunnelStart).toHaveBeenCalledTimes(1);
    expect(window.multissh.openExternal).toHaveBeenNthCalledWith(1, 'http://localhost:9080');
    expect(window.multissh.openExternal).toHaveBeenNthCalledWith(2, 'http://localhost:9080');
  });

  // M10: the tunnel is started with an await; if the terminal is closed meanwhile, nothing is left to stop it.
  it('stops a tunnel that finished starting after the terminal was closed, and does not open the browser', async () => {
    let finishTunnel!: (tunnel: { id: string; status: string }) => void;
    (window.multissh.sshTunnelStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => (finishTunnel = resolve))
    );
    const { result, unmount } = renderHook(() => usePortDetection({ enabled: true, isRemote: true, config: sampleConfig }));

    let forwarding!: Promise<void>;
    await act(async () => {
      forwarding = result.current.handleForwardAndOpen(8080, 'http');
      await Promise.resolve();
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      finishTunnel({ id: 'late-tunnel', status: 'active' });
      await forwarding;
    });

    expect(window.multissh.sshTunnelStop).toHaveBeenCalledWith('late-tunnel');
    expect(window.multissh.openExternal).not.toHaveBeenCalled();
  });
});
