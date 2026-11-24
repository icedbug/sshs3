import fs from 'node:fs/promises';
import path from 'node:path';
import { SCENARIOS } from '../scenarios';
import type { CampaignDeps } from './campaign';
import { labUp } from './lab';
import { startModelProxy } from './modelProxy';
import { startProduct } from './product';
import { resultsDir, runOne } from './run';
import { STATE_DIR } from './ssh';
import { labTls } from './tls';

/**
 * What a real campaign runs on: the labs, one model proxy to OpenAI for all its runs, and a fresh web
 * server for each run, so that nothing one run left in the product (memory, learning) reaches the next.
 */
export async function defaultDeps(): Promise<CampaignDeps> {
  const proxy = await startModelProxy({ port: 0, host: '0.0.0.0', tls: await labTls(), upstream: 'https://api.openai.com', logDir: path.join(resultsDir(), '_proxy') });
  return {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, group: s.group })),
    freeBytes: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      const st = await fs.statfs(dir);
      return st.bavail * st.bsize;
    },
    prepareLab: async (lab) => {
      await labUp(lab, { waitHealthy: false });
    },
    runOne: async ({ lab, scenario, model }) => {
      const s = SCENARIOS.find((x) => x.id === scenario);
      if (!s) throw new Error(`No task is named "${scenario}".`);
      const dataDir = path.join(STATE_DIR, 'products', `${new Date().toISOString().replace(/[-:.]/g, '')}-lab${lab}-${scenario}`);
      await fs.mkdir(dataDir, { recursive: true });
      const product = await startProduct({ dataDir, port: 0 });
      try {
        return await runOne({ lab, product, proxy, scenario: s, model });
      } finally {
        await product.stop();
      }
    },
    close: () => proxy.stop(),
  };
}
