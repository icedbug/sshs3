import type { Mode } from './scenario';

/**
 * How the runs of one campaign differ from a plain run: the agent's mode, the model's reasoning level
 * and context window, the lab's limits, who answers the cards, the way the request reaches the agent,
 * the servers' login shell, and a disturbance on purpose. A campaign has one variant for all its runs,
 * so that its runs can be compared with each other and with another campaign's.
 */

/** The way a request reaches the agent and its people answer (see channels/). `review` is the investigators' door. */
export type Via = 'panel' | 'browser' | 'review' | 'chat' | 'alert' | 'mcp' | 'desktop';
export type Shell = 'bash' | 'zsh' | 'fish' | 'dash';
export type Reasoning = 'low' | 'medium' | 'high';
export type Approver = 'oracle' | 'careful';
export type DisturbKind =
  | 'model-429'
  | 'model-500'
  | 'model-500-long'
  | 'model-cut'
  | 'model-cut-long'
  | 'model-slow'
  | 'model-stall'
  | 'terminal-drop'
  | 'server-restart'
  | 'product-restart'
  | 'disk-full'
  | 'netem';

export interface Caps {
  modelCalls: number;
  commands: number;
  minutes: number;
}

export interface Variant {
  mode?: Mode;
  reasoning?: Reasoning;
  contextWindow?: number;
  caps?: Caps;
  approver?: Approver;
  via?: Via;
  shell?: Shell;
  disturb?: DisturbKind;
}

/** A run stops at the first of these. The same caps as the real-model test in tests/main. */
export const DEFAULT_CAPS: Caps = { modelCalls: 60, commands: 40, minutes: 15 };

const MODES: Mode[] = ['advice', 'assisted', 'plan', 'autonomous'];
const REASONING: Reasoning[] = ['low', 'medium', 'high'];
const VIAS: Via[] = ['panel', 'browser', 'review', 'chat', 'alert', 'mcp', 'desktop'];
const SHELLS: Shell[] = ['bash', 'zsh', 'fish', 'dash'];
const APPROVERS: Approver[] = ['oracle', 'careful'];
export const DISTURB_KINDS: DisturbKind[] = [
  'model-429',
  'model-500',
  'model-500-long',
  'model-cut',
  'model-cut-long',
  'model-slow',
  'model-stall',
  'terminal-drop',
  'server-restart',
  'product-restart',
  'disk-full',
  'netem',
];

/** What the product does when the lab names no setting: such a setting makes no variant of its own. */
const PRODUCT_REASONING: Reasoning = 'medium';
const PRODUCT_CONTEXT_WINDOW = 128_000;

const sameCaps = (a: Caps, b: Caps): boolean => a.modelCalls === b.modelCalls && a.commands === b.commands && a.minutes === b.minutes;

/** The variant without what is a plain run's anyway. */
export function normalVariant(v: Variant | undefined): Variant {
  const out: Variant = {};
  if (!v) return out;
  if (v.approver && v.approver !== 'oracle') out.approver = v.approver;
  if (v.caps && !sameCaps(v.caps, DEFAULT_CAPS)) out.caps = { ...v.caps };
  if (v.contextWindow !== undefined && v.contextWindow !== PRODUCT_CONTEXT_WINDOW) out.contextWindow = v.contextWindow;
  if (v.disturb) out.disturb = v.disturb;
  if (v.mode) out.mode = v.mode;
  if (v.reasoning && v.reasoning !== PRODUCT_REASONING) out.reasoning = v.reasoning;
  if (v.shell && v.shell !== 'bash') out.shell = v.shell;
  if (v.via && v.via !== 'panel') out.via = v.via;
  return out;
}

/** `''` for a plain run, otherwise its settings as `key=value`, in a fixed order, joined by commas. */
export function variantKey(v: Variant | undefined): string {
  const n = normalVariant(v);
  const parts: string[] = [];
  if (n.approver) parts.push(`approver=${n.approver}`);
  if (n.caps) parts.push(`caps=${n.caps.modelCalls}/${n.caps.commands}/${n.caps.minutes}`);
  if (n.contextWindow !== undefined) parts.push(`context=${n.contextWindow}`);
  if (n.disturb) parts.push(`disturb=${n.disturb}`);
  if (n.mode) parts.push(`mode=${n.mode}`);
  if (n.reasoning) parts.push(`reasoning=${n.reasoning}`);
  if (n.shell) parts.push(`shell=${n.shell}`);
  if (n.via) parts.push(`via=${n.via}`);
  return parts.join(',');
}

const oneOf = <T extends string>(value: string, allowed: T[], what: string): T => {
  if ((allowed as string[]).includes(value)) return value as T;
  const list = allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}` : allowed.join('');
  throw new Error(`${what} is ${list}, not "${value}".`);
};

/** The variant the command line names; each setting is checked, and an unknown value refused in plain words. */
export function parseVariant(flags: {
  mode?: string;
  reasoning?: string;
  context?: string;
  caps?: string;
  approver?: string;
  via?: string;
  shell?: string;
  disturb?: string;
}): Variant {
  const v: Variant = {};
  if (flags.mode !== undefined) v.mode = oneOf(flags.mode, MODES, 'A mode');
  if (flags.reasoning !== undefined) v.reasoning = oneOf(flags.reasoning, REASONING, 'A reasoning level');
  if (flags.context !== undefined) {
    const tokens = Number(flags.context);
    if (!/^\d+$/.test(flags.context) || tokens < 8000 || tokens > 2_000_000) throw new Error(`A context window is a number of tokens from 8000 to 2000000, not "${flags.context}".`);
    v.contextWindow = tokens;
  }
  if (flags.caps !== undefined) {
    const parts = flags.caps.split(',');
    if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p) && Number(p) > 0)) throw new Error(`Caps are calls,commands,minutes, three whole numbers above 0, not "${flags.caps}".`);
    const [modelCalls, commands, minutes] = parts.map(Number) as [number, number, number];
    v.caps = { modelCalls, commands, minutes };
  }
  if (flags.approver !== undefined) v.approver = oneOf(flags.approver, APPROVERS, 'An approver');
  if (flags.via !== undefined) v.via = oneOf(flags.via, VIAS, 'A way in');
  if (flags.shell !== undefined) v.shell = oneOf(flags.shell, SHELLS, 'A shell');
  if (flags.disturb !== undefined) v.disturb = oneOf(flags.disturb, DISTURB_KINDS, 'A disturbance');
  return v;
}

/**
 * The settings the lab cannot run yet, as the flags that name them. A campaign with one of them is
 * refused before it starts: run as a plain run, it would be counted as what it was not.
 */
export function notYetSupported(v: Variant | undefined): string[] {
  const n = normalVariant(v);
  const missing: string[] = [];
  if (n.disturb) missing.push(`--disturb ${n.disturb}`);
  if (n.shell) missing.push(`--shell ${n.shell}`);
  if (n.via) missing.push(`--via ${n.via}`);
  return missing;
}

export function capsFor(v: Variant | undefined): Caps {
  return v?.caps ?? DEFAULT_CAPS;
}
