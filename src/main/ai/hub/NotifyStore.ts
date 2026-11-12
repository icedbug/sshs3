import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptSecretValue, encryptSecretValue } from "../../crypto/SecretFieldCrypto";
import type { NotifyChannel } from "./Notifier";

interface NotifyData {
  version: 1;
  channels: NotifyChannel[];
  /** Inbox items already handled, by id, with when they were first seen. */
  seen: Record<string, number>;
  /** Items already reminded about. */
  reminded: Record<string, number>;
  publicUrl: string;
  reminderMinutes: number;
}

const empty = (): NotifyData => ({ version: 1, channels: [], seen: {}, reminded: {}, publicUrl: "", reminderMinutes: 5 });

/**
 * Where notification channels are kept: a file of its own beside the hub's
 * store, readable by the owner only, with the addresses encrypted where the
 * system can. Not in the hub's store, which rewrites anything that looks like
 * a secret when it saves, and not in the team bucket: an address is the key
 * to its channel.
 */
export class NotifyStore {
  data: NotifyData = empty();
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<NotifyData>;
      this.data = {
        ...empty(),
        ...raw,
        version: 1,
        channels: (raw.channels ?? []).map((c) => ({
          ...c,
          url: decryptSecretValue(c.url ?? ""),
          secret: c.secret ? decryptSecretValue(c.secret) : undefined,
        })),
      };
    } catch {
      this.data = empty();
    }
  }

  save(): Promise<void> {
    const content = JSON.stringify({
      ...this.data,
      channels: this.data.channels.map((c) => ({
        ...c,
        url: encryptSecretValue(c.url),
        secret: c.secret ? encryptSecretValue(c.secret) : undefined,
      })),
    });
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
