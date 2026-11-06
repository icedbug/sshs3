import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { app } from 'electron';
import {
  SNIPPETS_MAX_COUNT,
  SNIPPET_MAX_COMMAND_CHARS,
  SNIPPET_MAX_NAME_CHARS,
  type Snippet,
} from '../../shared/types/snippets';

/** What snippets.json holds. */
interface SnippetData {
  snippets: Snippet[];
  /**
   * Built-in snippets the user deleted. Built-ins ship with the app and are not stored here (see
   * listWithBuiltins); a deleted one is remembered by id so it stays hidden instead of coming back.
   */
  hiddenBuiltinIds: string[];
}

/** Ids come from the renderer and the built-in lists; the IPC handlers accept up to 128 characters. */
const MAX_ID_CHARS = 128;

function isSnippetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/** Saved terminal command snippets. Stored as plain JSON: snippets are commands, not secrets. */
export class SnippetStore {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: SnippetData | null = null;

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.filePath = path.join(baseDir, 'snippets.json');
    }
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  private isSnippet(value: unknown): value is Snippet {
    const s = value as Snippet;
    return (
      !!s &&
      typeof s.id === 'string' &&
      typeof s.name === 'string' &&
      typeof s.command === 'string' &&
      (s.hostKey === undefined || typeof s.hostKey === 'string') &&
      (s.hostLabel === undefined || typeof s.hostLabel === 'string')
    );
  }

  private async load(): Promise<SnippetData> {
    if (this.cache) return this.cache;
    const data: SnippetData = { snippets: [], hiddenBuiltinIds: [] };
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      // No file yet means an empty store; any other read error must not be mistaken for "empty",
      // or the next save would overwrite the snippets on disk.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.snippets)) data.snippets = parsed.snippets.filter((s: unknown) => this.isSnippet(s));
        if (Array.isArray(parsed?.hiddenBuiltinIds)) {
          data.hiddenBuiltinIds = [...new Set<string>(parsed.hiddenBuiltinIds.filter(isSnippetId))].slice(
            0,
            SNIPPETS_MAX_COUNT
          );
        }
      } catch {
        // Unparseable file: keep a copy before a later save replaces it.
        await fs.copyFile(this.filePath, `${this.filePath}.corrupt`).catch(() => {});
      }
    }
    this.cache ??= data;
    return this.cache;
  }

  private async persist(data: SnippetData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const file = {
      version: 1,
      snippets: data.snippets,
      ...(data.hiddenBuiltinIds.length > 0 ? { hiddenBuiltinIds: data.hiddenBuiltinIds } : {}),
    };
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** All snippets, or with `hostKey` only the global ones plus those limited to that connection. */
  public async list(hostKey?: string): Promise<Snippet[]> {
    await this.writeQueue;
    const { snippets } = await this.load();
    return snippets.filter((s) => hostKey === undefined || !s.hostKey || s.hostKey === hostKey);
  }

  /**
   * Like list, followed by the `builtins` (the app's shipped snippets, passed in by the caller) the user
   * has not deleted. A stored snippet with a built-in's id is the user's edited copy of it and replaces it,
   * also on connections that copy is not limited to.
   */
  public async listWithBuiltins(builtins: readonly Snippet[], hostKey?: string): Promise<Snippet[]> {
    await this.writeQueue;
    const { snippets, hiddenBuiltinIds } = await this.load();
    const replaced = new Set([...hiddenBuiltinIds, ...snippets.map((s) => s.id)]);
    return [...snippets, ...builtins.filter((b) => !replaced.has(b.id)).map((b) => ({ ...b }))].filter(
      (s) => hostKey === undefined || !s.hostKey || s.hostKey === hostKey
    );
  }

  /**
   * Inserts a new snippet (no/unknown id) or replaces the existing one with that id. With
   * `replacesBuiltin`, `input.id` is a built-in snippet's: the first save stores the user's edited copy
   * under that id, so it replaces the built-in (listWithBuiltins) instead of being listed next to it.
   */
  public async save(
    input: Omit<Snippet, 'id'> & { id?: string },
    options: { replacesBuiltin?: boolean } = {}
  ): Promise<Snippet> {
    const name = input.name.trim().slice(0, SNIPPET_MAX_NAME_CHARS);
    if (!name || !input.command.trim() || input.command.length > SNIPPET_MAX_COMMAND_CHARS) {
      throw new Error('Invalid snippet');
    }
    const requestedId = input.id;
    return this.queueMutation(async () => {
      const data = await this.load();
      const { snippets } = data;
      const existing = requestedId ? snippets.findIndex((s) => s.id === requestedId) : -1;
      const newId = options.replacesBuiltin && isSnippetId(requestedId) ? requestedId : crypto.randomUUID();
      const snippet: Snippet = {
        id: existing >= 0 ? snippets[existing].id : newId,
        name,
        command: input.command,
        ...(input.hostKey ? { hostKey: input.hostKey, hostLabel: input.hostLabel ?? '' } : {}),
      };
      if (existing < 0 && snippets.length >= SNIPPETS_MAX_COUNT) throw new Error('Too many snippets');
      const next: SnippetData = {
        ...data,
        snippets: existing >= 0 ? snippets.map((s, i) => (i === existing ? snippet : s)) : [...snippets, snippet],
      };
      await this.persist(next);
      this.cache = next;
      return snippet;
    });
  }

  public async delete(id: string): Promise<void> {
    return this.queueMutation(async () => {
      const data = await this.load();
      const next: SnippetData = { ...data, snippets: data.snippets.filter((s) => s.id !== id) };
      await this.persist(next);
      this.cache = next;
    });
  }

  /**
   * Deletes a built-in snippet: its id is remembered so the shipped snippet stays hidden from
   * listWithBuiltins, and the user's edited copy of it (stored under the same id) is deleted too.
   */
  public async hideBuiltin(id: string): Promise<void> {
    if (!isSnippetId(id)) throw new Error('Invalid snippet id');
    return this.queueMutation(async () => {
      const data = await this.load();
      const next: SnippetData = {
        snippets: data.snippets.filter((s) => s.id !== id),
        hiddenBuiltinIds: data.hiddenBuiltinIds.includes(id) ? data.hiddenBuiltinIds : [...data.hiddenBuiltinIds, id],
      };
      await this.persist(next);
      this.cache = next;
    });
  }
}
