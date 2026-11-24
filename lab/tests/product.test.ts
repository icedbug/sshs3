import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentTask } from '../../src/shared/types/aiHub';
import { fakeOpenAi, type FakeOpenAi } from '../../tests/helpers/fakeOpenAi';
import { labDown, labGateway, labUp, type LabState } from '../src/lab';
import { startModelProxy, type ModelProxy } from '../src/modelProxy';
import { lastSourceCommit, productBuild, startProduct, type Account, type Product } from '../src/product';
import { exec } from '../src/ssh';
import { labTls } from '../src/tls';

// Lab 9 is the tests' own: the campaigns use 1 and 2.
const N = 9;
let lab: LabState;
let model: FakeOpenAi;
let proxy: ModelProxy;
let product: Product;
let tmp: string;

async function settled(account: Account, taskId: string, timeoutMs = 120_000): Promise<AgentTask> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const task = await account.task(taskId);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > until) throw new Error(`The run did not end within ${timeoutMs / 1000} s; it is ${task.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('the product driver', () => {
  beforeAll(async () => {
    lab = await labUp(N);
    // The model: asks to run `hostname`, then answers with a word the test looks for.
    model = await fakeOpenAi([{ tool: 'terminal_command', args: { command: 'hostname', description: 'Which server this terminal is on' } }, { text: 'HOSTNAME-SEEN' }], { responses: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-product-'));
    // The shared web server never calls its own loopback, and reaches a model elsewhere only over https:
    // the proxy answers over https at the lab network's gateway, an address of this machine.
    proxy = await startModelProxy({ port: 0, host: '0.0.0.0', tls: await labTls(), upstream: new URL(model.url).origin, logDir: path.join(tmp, 'calls') });
    product = await startProduct({ dataDir: path.join(tmp, 'data'), port: 0 });
  });

  afterAll(async () => {
    await product?.stop();
    await proxy?.stop();
    await model?.close();
    await labDown(N);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('a conversation runs a command on a lab server and answers', async () => {
    // The shipped web server, built from the product code as it is committed now.
    const build = await productBuild();
    expect(build.sourceCommit).toBe(await lastSourceCommit());
    // On the Node the product asks for (package.json: 24.15 or later in 24), not the lab's own.
    expect(product.node).toMatch(/^v24\.(1[5-9]|[2-9]\d)\./);

    const { maria } = await product.team();
    await maria.useModel('fake-1', 'product-test', `https://${labGateway(lab)}:${proxy.port}`);
    await maria.trustLab(lab);
    await maria.saveProfiles(lab);
    const sessionId = await maria.openTerminal('web-01');
    const taskId = await maria.start({ prompt: 'Which server is this terminal on?', mode: 'assisted', sessionId });
    const task = await settled(maria, taskId);

    expect(task.status, `${task.error ?? ''} ${task.messages.map((m) => `${m.role}: ${m.text}`).join(' | ').slice(-1500)}`).toBe('completed');
    expect(task.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')).toContain('HOSTNAME-SEEN');
    // The command ran in the real terminal on web-01, and the answer streamed to the page.
    expect(maria.events.some((e) => e.channel === 'terminal:data' && e.args[0] === sessionId && String(e.args[1]).includes('web-01'))).toBe(true);
    expect(maria.events.some((e) => e.channel === 'ai-hub:delta')).toBe(true);
    // Every model call went through the proxy under the run's name.
    expect((await proxy.calls('product-test')).filter((c) => c.path.endsWith('/responses')).length).toBeGreaterThanOrEqual(2);
  });

  it('a lab server cannot use the model proxy', async () => {
    // An agent runs commands on the lab servers: from there the proxy, which spends the real key, is shut.
    const web = lab.servers.find((s) => s.name === 'web-01')!;
    const tried = await exec(web.ip, `curl -s -o /dev/null -w '%{http_code}' -m 5 -k -X POST -H 'Authorization: Bearer lab-from-a-server' -d '{}' https://${labGateway(lab)}:${proxy.port}/v1/responses; echo " exit=$?"`);
    expect(tried.stdout).toMatch(/^403 exit=0/);
    expect(await proxy.calls('from-a-server')).toEqual([]);
    expect(model.requests.filter((r) => JSON.stringify(r).includes('from-a-server'))).toEqual([]);
  });
});
