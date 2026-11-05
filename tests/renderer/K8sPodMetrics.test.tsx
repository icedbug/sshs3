// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { K8sPodMetrics } from '../../src/renderer/src/components/K8s/K8sPodMetrics';

describe('K8sPodMetrics', () => {
  const perfK8sSampleMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    (window as any).multissh = {
      perfK8sSample: perfK8sSampleMock,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders loading indicator while fetching', async () => {
    perfK8sSampleMock.mockReturnValue(new Promise(() => {})); // pending promise

    render(
      <K8sPodMetrics
        contextName="minikube"
        namespace="default"
        podName="nginx-pod"
        containers={['nginx']}
      />
    );

    expect(screen.getByText(/Querying metrics.k8s.io/i)).toBeInTheDocument();
  });

  it('renders CPU and memory metrics when sample succeeds', async () => {
    perfK8sSampleMock.mockResolvedValue({
      ok: true,
      raw: {
        t: Date.now(),
        cpuMillicores: 35,
        memBytes: 52428800, // 50 MB
        cpuLimitMillicores: 100,
        memLimitBytes: 104857600, // 100 MB
        cpuRequestMillicores: 20,
        memRequestBytes: 26214400, // 25 MB
        restarts: 0,
      },
    });

    await act(async () => {
      render(
        <K8sPodMetrics
          contextName="minikube"
          namespace="default"
          podName="nginx-pod"
          containers={['nginx']}
        />
      );
    });

    expect(screen.getByText('35m')).toBeInTheDocument();
    expect(screen.getByText('50.0 MB')).toBeInTheDocument();
    expect(screen.getByText('35% of limit')).toBeInTheDocument();
    expect(screen.getByText('50% of limit')).toBeInTheDocument();
  });

  it('renders no-metrics message when metrics server is not reporting', async () => {
    perfK8sSampleMock.mockResolvedValue({
      ok: false,
      reason: 'no-metrics',
    });

    await act(async () => {
      render(
        <K8sPodMetrics
          contextName="minikube"
          namespace="default"
          podName="nginx-pod"
          containers={['nginx']}
        />
      );
    });

    expect(screen.getByText(/Metrics server not reporting/i)).toBeInTheDocument();
  });

  it('renders forbidden message when access is denied by RBAC', async () => {
    perfK8sSampleMock.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
    });

    await act(async () => {
      render(
        <K8sPodMetrics
          contextName="minikube"
          namespace="default"
          podName="nginx-pod"
          containers={['nginx']}
        />
      );
    });

    expect(screen.getByText(/Metrics access denied/i)).toBeInTheDocument();
  });

  it('allows switching containers in multi-container pods', async () => {
    perfK8sSampleMock.mockResolvedValue({
      ok: true,
      raw: {
        t: Date.now(),
        cpuMillicores: 10,
        memBytes: 10485760,
        restarts: 0,
      },
    });

    await act(async () => {
      render(
        <K8sPodMetrics
          contextName="minikube"
          namespace="default"
          podName="nginx-pod"
          containers={['app', 'sidecar']}
        />
      );
    });

    expect(perfK8sSampleMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'app' })
    );

    const select = screen.getByLabelText(/Container:/i);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'sidecar' } });
    });

    expect(perfK8sSampleMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'sidecar' })
    );
  });

  it('refreshes metrics when clicking the refresh button', async () => {
    perfK8sSampleMock.mockResolvedValue({
      ok: true,
      raw: {
        t: Date.now(),
        cpuMillicores: 15,
        memBytes: 20971520,
        restarts: 0,
      },
    });

    await act(async () => {
      render(
        <K8sPodMetrics
          contextName="minikube"
          namespace="default"
          podName="nginx-pod"
          containers={['nginx']}
        />
      );
    });

    expect(perfK8sSampleMock).toHaveBeenCalledTimes(1);

    const refreshBtn = screen.getByRole('button', { name: /^Refresh$/i });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(perfK8sSampleMock).toHaveBeenCalledTimes(2);
  });
});
