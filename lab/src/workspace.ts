import fs from 'node:fs/promises';
import path from 'node:path';
import { labGateway, labUp, type LabState } from './lab';
import { ANTHROPIC_ROUTE, startModelProxy, type ModelProxy } from './modelProxy';
import { PASSWORDS, startProduct, type Product, type Team } from './product';
import { resultsDir } from './run';
import { controlKey, STATE_DIR } from './ssh';
import { labTls, trustBundle } from './tls';

export type Person = keyof Team;
export const PEOPLE: readonly Person[] = ['maria', 'omar', 'lina'];

/** What a tester needs to use the workspace: where it is, who may sign in, and the servers it manages. */
export interface WorkspaceInfo {
  lab: number;
  baseUrl: string;
  model: string;
  /** The commit of the product code the web server was built from. */
  commit: string;
  startedAt: string;
  /** Maria is the administrator; Omar and Lina are members, invited by her. */
  people: Record<Person, { username: string; password: string; role: 'admin' | 'member' }>;
  servers: Array<{ name: string; ip: string; role: string; description: string }>;
  /** The file the model proxy writes each person's model calls to, one JSON line per call. */
  modelCalls: Record<Person, string>;
  /** The lab's own key to every server: what a check uses to see a server's state for itself. */
  serverKey: string;
  /**
   * For another copy of the app on the same lab (the desktop app): the model proxy, which takes any
   * dummy key `lab-<runId>` and writes that run's calls next to the people's; the servers' host keys,
   * for its known_hosts; and the lab's CA, which the proxy's certificate is signed by.
   */
  proxyUrl: string;
  hostKeys: string;
  trustBundle: string;
}

export interface Workspace {
  info: WorkspaceInfo;
  lab: LabState;
  product: Product;
  team: Team;
  proxy: ModelProxy;
  proxyUrl: string;
  /** Gives the person's AI settings the model under this name, so that the proxy files its calls by it. */
  useModel(who: Person, runId: string, model?: string): Promise<void>;
  stop(): Promise<void>;
}

export const workspaceFile = (lab: number): string => path.join(STATE_DIR, `workspace-${lab}.json`);

/**
 * A team's AI workspace on the lab: the lab's servers, the product's web server with Maria, Omar and
 * Lina, every one of them with the model through the lab's proxy, the servers' keys and the team's
 * shared server profiles. Nothing is broken on purpose: the servers are only the company's servers that
 * the workspace's functions act on.
 */
export async function startWorkspace(opts: { lab: number; model: string; dataDir?: string }): Promise<Workspace> {
  const lab = await labUp(opts.lab, { waitHealthy: true });
  const proxy = await startModelProxy({ port: 0, host: '0.0.0.0', tls: await labTls(), upstream: 'https://api.openai.com', anthropic: ANTHROPIC_ROUTE, logDir: path.join(resultsDir(), '_proxy') });
  const proxyUrl = `https://${labGateway(lab)}:${proxy.port}`;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const dataDir = opts.dataDir ?? path.join(STATE_DIR, 'products', `${stamp}-workspace-lab${opts.lab}`);
  await fs.mkdir(dataDir, { recursive: true });
  let product: Product | undefined;
  try {
    product = await startProduct({ dataDir, port: 0 });
    const team = await product.team();
    const useModel = async (who: Person, runId: string, model = opts.model): Promise<void> => team[who].useModel(model, runId, proxyUrl);
    const runIdOf = (who: Person): string => `ws-${stamp}-${who}`;
    for (const who of PEOPLE) {
      await useModel(who, runIdOf(who));
      await team[who].trustLab(lab);
    }
    await team.maria.saveProfiles(lab);
    const info: WorkspaceInfo = {
      lab: opts.lab,
      baseUrl: product.baseUrl,
      model: opts.model,
      commit: product.commit,
      startedAt: new Date().toISOString(),
      people: {
        maria: { username: 'maria', password: PASSWORDS.maria, role: 'admin' },
        omar: { username: 'omar', password: PASSWORDS.omar, role: 'member' },
        lina: { username: 'lina', password: PASSWORDS.lina, role: 'member' },
      },
      servers: lab.servers.map((s) => ({ name: s.name, ip: s.ip, role: s.role, description: s.description })),
      modelCalls: { maria: proxy.logFile(runIdOf('maria')), omar: proxy.logFile(runIdOf('omar')), lina: proxy.logFile(runIdOf('lina')) },
      serverKey: (await controlKey()).privateKeyPath,
      proxyUrl,
      hostKeys: lab.hostKeys,
      trustBundle: await trustBundle(),
    };
    await fs.writeFile(workspaceFile(opts.lab), JSON.stringify(info, null, 2), { mode: 0o600 });
    const started = product;
    return {
      info,
      lab,
      product: started,
      team,
      proxy,
      proxyUrl,
      useModel,
      async stop() {
        await started.stop();
        await proxy.stop();
        await fs.rm(workspaceFile(opts.lab), { force: true });
      },
    };
  } catch (error) {
    await product?.stop();
    await proxy.stop();
    throw error;
  }
}
