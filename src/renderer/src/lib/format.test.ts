import { describe, expect, it } from 'vitest';
import { describeIpcError } from './format';
import { offersAwsSsoSignIn } from '../../../shared/types/aws';

describe('describeIpcError', () => {
  it('strips the Electron IPC prefix and the redundant "Error:" label', () => {
    const err = new Error("Error invoking remote method 'storage:list': Error: AWS SSO session expired: sign in again to continue.");
    const msg = describeIpcError(err, 'fallback');
    expect(msg).toBe('AWS SSO session expired: sign in again to continue.');
    expect(offersAwsSsoSignIn(msg)).toBe(true);
  });

  it('falls back when the error has no message', () => {
    expect(describeIpcError(new Error(''), 'fallback')).toBe('fallback');
  });
});
