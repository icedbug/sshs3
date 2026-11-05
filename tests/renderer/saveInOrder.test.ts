import { describe, it, expect, vi } from 'vitest';
import { saveInOrder } from '../../src/renderer/src/lib/saveInOrder';

describe('saveInOrder', () => {
  it('saves each profile in turn, then reloads once, and reports success', async () => {
    const order: string[] = [];
    const save = vi.fn(async (p: { id: string }) => {
      order.push(`save ${p.id}`);
    });
    const reload = vi.fn(async () => {
      order.push('reload');
    });
    const onError = vi.fn();
    const ok = await saveInOrder([{ id: 'a' }, { id: 'b' }], save, reload, onError, 'Failed');
    expect(ok).toBe(true);
    expect(order).toEqual(['save a', 'save b', 'reload']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops at the first failure, reloads what was saved and only then reports it', async () => {
    const order: string[] = [];
    const save = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('vault is locked'));
    const reload = vi.fn(async () => {
      order.push('reload');
    });
    const onError = vi.fn(() => {
      order.push('error');
    });
    const ok = await saveInOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], save, reload, onError, 'Failed to move');
    expect(ok).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['reload', 'error']);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('vault is locked'));
  });
});
