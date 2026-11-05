import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeDetached,
  getLiveSession,
  killUnlessReclaimed,
  markDetached,
  queueAttach,
  registerLiveSession,
  resetLiveSessions,
  takeAttach,
  unmarkDetached,
  unregisterLiveSession,
} from './liveSessions';

describe('liveSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveSessions();
  });
  afterEach(() => vi.useRealTimers());

  it('tracks the session a pane shows and ignores a stale unregister', () => {
    registerLiveSession('p1', { sessionId: 's2', kind: 'ssh' });
    unregisterLiveSession('p1', 's1');
    expect(getLiveSession('p1')?.sessionId).toBe('s2');
    unregisterLiveSession('p1', 's2');
    expect(getLiveSession('p1')).toBeUndefined();
  });

  it('hands a queued session to its pane, and again to an immediate remount only', () => {
    queueAttach([{ paneId: 'p1', sessionId: 's1', kind: 'k8s' }]);
    expect(takeAttach('p2')).toBeUndefined();
    expect(takeAttach('p1')).toEqual({ sessionId: 's1', kind: 'k8s' });
    expect(takeAttach('p1')?.sessionId).toBe('s1');
    vi.advanceTimersByTime(2100);
    expect(takeAttach('p1')).toBeUndefined();
  });

  it('leaves a detached session running exactly once', () => {
    markDetached(['s1', 's2']);
    unmarkDetached(['s2']);
    expect(consumeDetached('s1')).toBe(true);
    expect(consumeDetached('s1')).toBe(false);
    expect(consumeDetached('s2')).toBe(false);
  });

  it('kills an attached session after the grace period unless it was claimed again', () => {
    const kill = vi.fn();
    queueAttach([{ paneId: 'p1', sessionId: 's1', kind: 'ssh' }]);
    takeAttach('p1');
    vi.advanceTimersByTime(10);

    killUnlessReclaimed('s1', kill);
    vi.advanceTimersByTime(10);
    takeAttach('p1'); // the StrictMode remount
    vi.advanceTimersByTime(300);
    expect(kill).not.toHaveBeenCalled();

    killUnlessReclaimed('s1', kill);
    vi.advanceTimersByTime(300);
    expect(kill).toHaveBeenCalledWith('s1');
  });
});
