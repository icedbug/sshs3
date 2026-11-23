import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { SignInJournal } from '../../src/main/web/SignInJournal';
import { ADMIN_PASSWORD, startWebServer, type WebServerKit } from '../helpers/webServerKit';

/**
 * W9: every refused sign-in was written into the journal, also the ones the limiter had already
 * refused, and the journal was one file that only grew.
 */
describe('web server: the sign-in journal', () => {
  let kit: WebServerKit;

  beforeEach(async () => {
    kit = await startWebServer();
  });

  afterEach(async () => {
    await kit.stop();
  });

  it('writes down that the limiter began to refuse, once, and not every attempt it refuses', async () => {
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const file = kit.server.signIns.file;
    const lines = async (): Promise<Array<{ what: string; actor: string }>> => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const before = (await lines()).length;
    const answers = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const res = await kit.send('POST', '/api/auth/login', { username: 'x'.repeat(200) + i, password: 'typed-into-the-wrong-field' }); // pragma: allowlist secret
      answers.set(res.body.error, (answers.get(res.body.error) ?? 0) + 1);
    }
    // 30 wrong attempts from one address are answered as wrong; the rest are refused by the limiter.
    expect(answers.get('Wrong user name or password')).toBe(30);
    expect(answers.get('Too many sign-in attempts. Wait a minute and try again.')).toBe(270);
    const added = (await lines()).slice(before);
    expect(added.filter((e) => e.what === 'failed to sign in')).toHaveLength(30);
    expect(added.filter((e) => /too many failed sign-ins/.test(e.what))).toHaveLength(1);
    expect(added).toHaveLength(31);
    // A name somebody typed is kept short.
    expect(Math.max(...added.map((e) => e.actor.length))).toBeLessThanOrEqual(80);
    expect((await kit.server.signIns.verify()).ok).toBe(true);
  });

  it('the same holds for the limit one account has', async () => {
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const before = (await kit.server.signIns.recent(500)).length;
    // Ten wrong passwords for one name: the account's own limit refuses before the address's does.
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const res = await kit.send('POST', '/api/auth/login', { username: 'maria', password: `wrong-${i}` });
      if (res.body.error?.startsWith('Too many')) refused++;
    }
    expect(refused).toBe(30);
    const added = (await kit.server.signIns.recent(500)).length - before;
    expect(added).toBe(11); // ten wrong passwords, then one line that says the rest are refused
  });
});

describe('the sign-in journal as files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sign-in-journal-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fill = async (journal: SignInJournal, n: number, from = 0): Promise<void> => {
    for (let i = from; i < from + n; i++) await journal.append({ kind: 'sign-in', actor: `person-${i}`, what: 'signed in', detail: 'from 203.0.113.9' });
  };

  it('begins a new file when one is full, keeps a few, and the files hang together', async () => {
    const journal = new SignInJournal(dir, { maxBytes: 2000, keep: 2 });
    await fill(journal, 60);
    const files = await journal.files();
    // The current file and the two newest put aside: whatever was older is gone.
    expect(files.map((f) => path.basename(f))).toEqual(['audit-server-2.jsonl', 'audit-server-1.jsonl', 'audit-server.jsonl']);
    let total = 0;
    for (const file of files) {
      const size = (await fs.stat(file)).size;
      total += size;
      // One entry may take a file over the line; it is never much more.
      expect(size).toBeLessThan(2000 + 600);
    }
    expect(total).toBeLessThan(3 * 2600);

    const check = await journal.verify();
    expect(check.ok).toBe(true);
    // Each file after the first begins by naming the end of the one before it.
    const first = JSON.parse((await fs.readFile(files[2]!, 'utf8')).split('\n')[0]!) as { what: string; detail: string; seq: number; prev: string };
    const lastBefore = JSON.parse((await fs.readFile(files[1]!, 'utf8')).trim().split('\n').at(-1)!) as { seq: number; hash: string };
    expect(first).toMatchObject({ seq: 1, prev: '', what: 'continued the journal in a new file' });
    expect(first.detail).toBe(`after entry ${lastBefore.seq} of the file before, hash ${lastBefore.hash}`);
    // The newest entries are the ones a screen shows.
    expect((await journal.recent(1))[0]!.actor).toBe('person-59');
  });

  it('says so when an older file was changed, cut or swapped', async () => {
    const journal = new SignInJournal(dir, { maxBytes: 2000, keep: 3 });
    await fill(journal, 40);
    const files = await journal.files();
    expect(files.length).toBeGreaterThanOrEqual(3);
    const older = files.at(-2)!;
    const original = await fs.readFile(older, 'utf8');

    // An entry in the middle of an older file is edited.
    await fs.writeFile(older, original.replace('person-', 'somebody-else-'));
    const edited = await journal.verify();
    expect(edited.ok).toBe(false);
    expect(edited.problem?.text).toContain(path.basename(older));

    // The last entries of an older file are cut off: its own chain still holds, the file after it does not follow.
    const lines = original.trim().split('\n');
    await fs.writeFile(older, lines.slice(0, -2).join('\n') + '\n');
    const cut = await journal.verify();
    expect(cut.ok).toBe(false);
    expect(cut.problem?.text).toMatch(/does not continue the file before it/);

    await fs.writeFile(older, original);
    expect((await journal.verify()).ok).toBe(true);
  });

  it('goes on in the same files after a restart', async () => {
    const first = new SignInJournal(dir, { maxBytes: 2000, keep: 3 });
    await fill(first, 25);
    const second = new SignInJournal(dir, { maxBytes: 2000, keep: 3 });
    await fill(second, 25, 25);
    expect((await second.verify()).ok).toBe(true);
    expect((await second.recent(1))[0]!.actor).toBe('person-49');
    const all = await second.files();
    expect(all.length).toBeGreaterThan(1);
    expect(all.length).toBeLessThanOrEqual(4);
  });

  it('with room to spare it is one file, as before', async () => {
    const journal = new SignInJournal(dir);
    await fill(journal, 5);
    expect((await journal.files()).map((f) => path.basename(f))).toEqual(['audit-server.jsonl']);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 5 });
  });
});
