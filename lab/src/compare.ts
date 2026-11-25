import fs from 'node:fs/promises';
import path from 'node:path';
import { loadQueue } from './campaign';
import { buildReport, type Rate } from './report';
import { resultsDir } from './run';
import { variantKey } from './variant';

/**
 * Campaigns side by side: per task and model, how many of its counted runs solved it, with the Wilson
 * 95% interval, in each campaign. Made from the queues and the grades only, so it can be made again.
 */

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const cell = (x: Rate | undefined): string => (x && x.counted ? `${x.solved}/${x.counted} (${pct(x.interval[0])} to ${pct(x.interval[1])})` : '-');

export async function compareCampaigns(names: string[]): Promise<{ file: string; markdown: string }> {
  if (names.length < 2) throw new Error('Name two campaigns or more: --names repeats,a-plan');
  const reports = await Promise.all(names.map((name) => buildReport(name)));
  const variants = await Promise.all(names.map(async (name) => variantKey((await loadQueue(name)).variant)));
  const header = names.map((name, i) => (variants[i] ? `${name} (${variants[i]})` : name));
  const lines: string[] = [`# ${names.join(', ')} side by side`, '', 'Solved of the runs counted, with the 95% interval.', ''];
  const row = (cells: string[]): void => {
    lines.push(`| ${cells.join(' | ')} |`);
  };
  row(['Task / model', ...header]);
  row(['---', ...names.map(() => '---')]);
  const keys = [...new Set(reports.flatMap((r) => Object.keys(r.byTaskAndModel)))].sort();
  for (const key of keys) row([key, ...reports.map((r) => cell(r.byTaskAndModel[key]))]);
  const models = [...new Set(reports.flatMap((r) => Object.keys(r.byModel)))].sort();
  for (const model of models) row([`all / ${model}`, ...reports.map((r) => cell(r.byModel[model]))]);
  lines.push('');
  const markdown = lines.join('\n');
  const file = path.join(resultsDir(), 'campaigns', 'compare', `${names.join('+')}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, markdown);
  return { file, markdown };
}
