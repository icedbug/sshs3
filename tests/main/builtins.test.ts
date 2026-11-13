import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = { app: { getPath: () => os.tmpdir() } };
  return { ...mockObj, default: mockObj };
});

import { DEMO_ENV_VARS, DEMO_FLAG, setDemoModeForTesting } from '../../src/main/demo/demoMode';
import {
  getDefaultAgents,
  getDefaultKbDocuments,
  getDefaultSkillsAndMemories,
  getDefaultSnippets,
} from '../../src/main/ai/hub/builtins';
import {
  getBuiltinAgents,
  getBuiltinKbDocuments,
  getBuiltinSkillsAndMemories,
  getBuiltinSnippets,
  getDemoAgents,
  getDemoKbDocuments,
  getDemoSnippets,
} from '../../src/main/ai/hub/demoWorkspace';
import { SnippetStore } from '../../src/main/snippets/SnippetStore';
import { registerSnippetHandlers, type AppDataHost } from '../../src/main/ipc/appDataHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { Snippet } from '../../src/shared/types/snippets';

/**
 * What ships built in (demoWorkspace getBuiltin*, the defaults in ai/hub/builtins.ts): the demo workspace's
 * fixtures in demo mode only, otherwise a few neutral defaults. And a built-in snippet the user deletes stays
 * deleted, in either mode.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  setDemoModeForTesting(undefined);
});

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-builtins-'));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return path.join(dir, name);
}

const idsOf = (items: ReadonlyArray<{ id: string }>): string[] => items.map((item) => item.id);

describe('built-ins per mode', () => {
  it('outside demo mode are exactly the neutral defaults: one agent, a few snippets, no documents or memories', () => {
    setDemoModeForTesting(false);
    expect(getBuiltinAgents()).toEqual(getDefaultAgents());
    expect(getBuiltinSnippets()).toEqual(getDefaultSnippets());
    expect(getBuiltinKbDocuments()).toEqual(getDefaultKbDocuments());
    expect(getBuiltinSkillsAndMemories()).toEqual(getDefaultSkillsAndMemories());

    expect(getDefaultAgents()).toHaveLength(1);
    expect(getDefaultSnippets().length).toBeGreaterThan(0);
    expect(getDefaultKbDocuments()).toEqual([]);
    expect(getDefaultSkillsAndMemories()).toEqual([]);
  });

  it('outside demo mode ship only read-only diagnostics as snippets', () => {
    setDemoModeForTesting(false);
    const changing = /\b(rm|mv|kill|pkill|reboot|shutdown|restart|stop|delete|apply|drain|cordon|scale|mkfs)\b|>/;
    expect(getBuiltinSnippets().filter((snippet) => changing.test(snippet.command))).toEqual([]);
  });

  it('in demo mode are the demo workspace fixtures, and none of the neutral defaults', () => {
    setDemoModeForTesting(true);
    expect(getBuiltinAgents()).toEqual(getDemoAgents());
    expect(getBuiltinSnippets()).toEqual(getDemoSnippets());
    expect(getBuiltinKbDocuments()).toEqual(getDemoKbDocuments());

    // The demo workspace's skills and built-in memories, never its other (workspace) memories.
    const memories = getBuiltinSkillsAndMemories();
    expect(idsOf(memories)).toEqual(expect.arrayContaining(['demo-skill-ontap-latency', 'builtin-mem-sre-golden-rules']));
    expect(memories.every((memory) => memory.kind === 'skill' || memory.id.startsWith('builtin-'))).toBe(true);
    expect(idsOf(memories)).not.toContain('demo-mem-ontap-topology');

    const demoIds = [
      ...idsOf(getBuiltinAgents()),
      ...idsOf(getBuiltinSnippets()),
      ...idsOf(getBuiltinKbDocuments()),
      ...idsOf(memories),
    ];
    for (const id of idsOf([...getDefaultAgents(), ...getDefaultSnippets()])) {
      expect(demoIds, id).not.toContain(id);
    }
  });
});

describe('built-ins follow how the process was launched', () => {
  type Launch = { args?: string[]; env?: Partial<Record<(typeof DEMO_ENV_VARS)[number], string>> };

  /** demoWorkspace freshly loaded, as a process launched with `launch` loads it (demo mode included). */
  async function demoWorkspaceLaunchedWith(launch: Launch) {
    const argv = process.argv;
    const env = new Map(DEMO_ENV_VARS.map((name) => [name, process.env[name]] as const));
    process.argv = [...argv.filter((arg) => arg !== DEMO_FLAG), ...(launch.args ?? [])];
    for (const name of DEMO_ENV_VARS) {
      const value = launch.env?.[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      vi.resetModules();
      return await import('../../src/main/ai/hub/demoWorkspace');
    } finally {
      process.argv = argv;
      for (const [name, value] of env) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('a process started with SSHS3_DEMO=1 ships the demo fixtures, also after the variable is gone', async () => {
    const demo = await demoWorkspaceLaunchedWith({ env: { SSHS3_DEMO: '1' } });
    expect(demo.isDemoMode()).toBe(true);
    expect(demo.getBuiltinSnippets()).toEqual(demo.getDemoSnippets());
    expect(idsOf(demo.getBuiltinAgents())).toContain('demo-agent-ontap-architect');
    expect(idsOf(demo.getBuiltinAgents())).not.toContain('builtin-agent-general');
  });

  it('a process started without demo mode ships the neutral defaults, also when the flag shows up later', async () => {
    const normal = await demoWorkspaceLaunchedWith({});
    expect(normal.isDemoMode()).toBe(false);
    expect(normal.getBuiltinSnippets()).toEqual(getDefaultSnippets());
    expect(normal.getBuiltinAgents()).toEqual(getDefaultAgents());

    const argv = process.argv;
    const variable = process.env.SSHS3_DEMO;
    process.argv = [...argv, DEMO_FLAG];
    process.env.SSHS3_DEMO = '1';
    try {
      expect(normal.isDemoMode()).toBe(false);
      expect(normal.getBuiltinSnippets()).toEqual(getDefaultSnippets());
      expect(normal.getBuiltinKbDocuments()).toEqual([]);
      expect(normal.getBuiltinSkillsAndMemories()).toEqual([]);
    } finally {
      process.argv = argv;
      if (variable === undefined) delete process.env.SSHS3_DEMO;
      else process.env.SSHS3_DEMO = variable;
    }
  });
});

describe('a deleted built-in snippet stays deleted', () => {
  /** The snippet IPC handlers over a SnippetStore on `file`: a new call is a restarted app. */
  function snippetIpc(file: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const host = {
      registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
      snippetStore: new SnippetStore(file),
    } as unknown as AppDataHost;
    registerSnippetHandlers(host);
    const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!({}, ...args);
    return {
      list: async () => (await invoke(IPC_CHANNELS.SNIPPETS_LIST)) as Snippet[],
      save: async (snippet: Partial<Snippet>) => (await invoke(IPC_CHANNELS.SNIPPETS_SAVE, snippet)) as Snippet,
      remove: async (id: string) => {
        await invoke(IPC_CHANNELS.SNIPPETS_DELETE, id);
      },
    };
  }

  const MODES: Array<[string, boolean]> = [
    ['outside demo mode', false],
    ['in demo mode', true],
  ];

  it.each(MODES)('%s, also after a restart', async (_mode, demo) => {
    setDemoModeForTesting(demo);
    const file = await tempFile('snippets.json');
    const [deleted, ...kept] = getBuiltinSnippets();

    const ipc = snippetIpc(file);
    expect(await ipc.list()).toEqual([deleted, ...kept]);
    await ipc.remove(deleted.id);

    expect(await ipc.list()).toEqual(kept);
    expect(await snippetIpc(file).list()).toEqual(kept);
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
      version: 1,
      snippets: [],
      hiddenBuiltinIds: [deleted.id],
    });
  });

  it('in demo mode, also when the user had edited the demo snippet before deleting it', async () => {
    setDemoModeForTesting(true);
    const file = await tempFile('snippets.json');
    const [first, second, ...rest] = getDemoSnippets();
    const ipc = snippetIpc(file);

    // An edited copy takes the demo snippet's place instead of being listed next to it ...
    const edited = await ipc.save({ id: second.id, name: second.name, command: `${second.command} | head -n 20` });
    expect(edited.id).toBe(second.id);
    expect(await ipc.list()).toEqual([edited, first, ...rest]);

    // ... and deleting it deletes the copy too: neither comes back, not after a restart either.
    await ipc.remove(second.id);
    expect(await ipc.list()).toEqual([first, ...rest]);
    expect(await snippetIpc(file).list()).toEqual([first, ...rest]);
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
      version: 1,
      snippets: [],
      hiddenBuiltinIds: [second.id],
    });
  });

  it("is remembered by its id only: the other mode's built-ins are all still there", async () => {
    const file = await tempFile('snippets.json');
    const ipc = snippetIpc(file);

    setDemoModeForTesting(false);
    const [deleted, ...kept] = getBuiltinSnippets();
    await ipc.remove(deleted.id);

    setDemoModeForTesting(true);
    expect(await ipc.list()).toEqual(getDemoSnippets());

    setDemoModeForTesting(false);
    expect(await ipc.list()).toEqual(kept);
  });
});
