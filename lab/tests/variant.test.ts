import { describe, expect, it } from 'vitest';
import { capReached } from '../src/run';
import { DEFAULT_CAPS, capsFor, notYetSupported, parseVariant, variantKey } from '../src/variant';

describe('a campaign variant', () => {
  it('the default variant has no key', () => {
    expect(variantKey({})).toBe('');
    // Settings that are what a run has anyway name no variant of their own.
    expect(variantKey({ approver: 'oracle', via: 'panel', shell: 'bash', reasoning: 'medium', contextWindow: 128_000, caps: { modelCalls: 60, commands: 40, minutes: 15 } })).toBe('');
  });

  it('a key lists its settings in a fixed order', () => {
    expect(variantKey({ mode: 'plan', contextWindow: 32_000 })).toBe('context=32000,mode=plan');
    expect(variantKey({ via: 'chat', shell: 'fish', disturb: 'netem', approver: 'careful', caps: { modelCalls: 120, commands: 80, minutes: 30 }, reasoning: 'low' })).toBe(
      'approver=careful,caps=120/80/30,disturb=netem,reasoning=low,shell=fish,via=chat',
    );
  });

  it('reads every flag', () => {
    expect(parseVariant({})).toEqual({});
    expect(parseVariant({ mode: 'autonomous', reasoning: 'high', context: '32000', caps: '120,80,30', approver: 'careful', via: 'review', shell: 'zsh', disturb: 'model-429' })).toEqual({
      mode: 'autonomous',
      reasoning: 'high',
      contextWindow: 32_000,
      caps: { modelCalls: 120, commands: 80, minutes: 30 },
      approver: 'careful',
      via: 'review',
      shell: 'zsh',
      disturb: 'model-429',
    });
  });

  it('an unknown value is refused in plain words', () => {
    expect(() => parseVariant({ mode: 'fast' })).toThrow('A mode is advice, assisted, plan or autonomous, not "fast".');
    expect(() => parseVariant({ reasoning: 'max' })).toThrow('A reasoning level is low, medium or high, not "max".');
    expect(() => parseVariant({ via: 'slack' })).toThrow('A way in is panel, browser, review, chat, alert, mcp or desktop, not "slack".');
    expect(() => parseVariant({ shell: 'tcsh' })).toThrow('A shell is bash, zsh, fish or dash, not "tcsh".');
    expect(() => parseVariant({ approver: 'boss' })).toThrow('An approver is oracle or careful, not "boss".');
    expect(() => parseVariant({ disturb: 'flood' })).toThrow(/^A disturbance is model-429, .* or netem, not "flood"\.$/);
    expect(() => parseVariant({ context: 'big' })).toThrow('A context window is a number of tokens from 8000 to 2000000, not "big".');
    expect(() => parseVariant({ caps: '10,20' })).toThrow('Caps are calls,commands,minutes, three whole numbers above 0, not "10,20".');
  });

  it('a setting the lab cannot run yet is named, so it is refused instead of run as a plain run', () => {
    expect(notYetSupported({ mode: 'plan', reasoning: 'low', contextWindow: 32_000, caps: { modelCalls: 120, commands: 80, minutes: 30 } })).toEqual([]);
    expect(notYetSupported({ via: 'panel', shell: 'bash', approver: 'oracle' })).toEqual([]);
    expect(notYetSupported({ via: 'chat', approver: 'careful', shell: 'fish', disturb: 'netem', mode: 'plan' })).toEqual(['--disturb netem', '--shell fish', '--via chat']);
  });

  it('caps come from the variant or stay 60, 40 and 15', () => {
    expect(DEFAULT_CAPS).toEqual({ modelCalls: 60, commands: 40, minutes: 15 });
    expect(capsFor(undefined)).toEqual(DEFAULT_CAPS);
    expect(capsFor({ mode: 'plan' })).toEqual(DEFAULT_CAPS);
    expect(capsFor({ caps: { modelCalls: 120, commands: 80, minutes: 30 } })).toEqual({ modelCalls: 120, commands: 80, minutes: 30 });
  });

  it('a raised cap lets a run go on past the usual one', () => {
    const ok = Array.from({ length: 70 }, () => ({ status: 200 }));
    expect(capReached({ calls: ok, commands: 0, ms: 0 })).toBe('60 model calls');
    expect(capReached({ calls: ok, commands: 50, ms: 20 * 60_000 }, { modelCalls: 120, commands: 80, minutes: 30 })).toBeUndefined();
    expect(capReached({ calls: [], commands: 80, ms: 0 }, { modelCalls: 120, commands: 80, minutes: 30 })).toBe('80 commands');
  });
});
