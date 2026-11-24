import fs from 'node:fs/promises';
import path from 'node:path';
import { SCENARIOS } from '../scenarios';
import type { CampaignDeps } from './campaign';
import { labUp } from './lab';
import { takeLock } from './lock';
import { startModelProxy } from './modelProxy';
import { productBuild, startProduct } from './product';
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
    scenarios: SCENARIOS.map((s) => ({ id: s.id, group: s.group, ...(s.injected?.length ? { injects: true } : {}) })),
    freeBytes: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      const st = await fs.statfs(dir);
      return st.bavail * st.bsize;
    },
    prepareLab: async (lab) => {
      await labUp(lab, { waitHealthy: false });
    },
    lockLab: (lab) => takeLock(path.join(STATE_DIR, `lab-${lab}.lock`), `Lab ${lab}`),
    // Built once, at the campaign's start; every run uses that build and no other.
    productCommit: async () => (await productBuild()).sourceCommit,
    runOne: async ({ lab, scenario, model, runId, productCommit }) => {
      const s = SCENARIOS.find((x) => x.id === scenario);
      if (!s) throw new Error(`No task is named "${scenario}".`);
      const dataDir = path.join(STATE_DIR, 'products', `${new Date().toISOString().replace(/[-:.]/g, '')}-lab${lab}-${scenario}`);
      await fs.mkdir(dataDir, { recursive: true });
      try {
        const product = await startProduct({ dataDir, port: 0, expectCommit: productCommit });
        try {
          return await runOne({ lab, product, proxy, scenario: s, model, runId });
        } finally {
          await product.stop();
        }
      } finally {
        // What the run needs from it was read and kept in the run's folder (task.json, the secret search).
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
    close: () => proxy.stop(),
  };
}
