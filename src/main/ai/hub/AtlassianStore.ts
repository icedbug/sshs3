import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptSecretValue, encryptSecretValue } from "../../crypto/SecretFieldCrypto";
import type { AtlassianAuth, AtlassianVariant } from "./Atlassian";

export type AtlassianProduct = "jira" | "confluence";

/** One connection: where, as whom, and what of it is mirrored. */
export interface AtlassianConnection {
  variant: AtlassianVariant;
  baseUrl: string;
  email?: string;
  /** A secret: whoever has it acts as the account. */
  token: string;
  /** Who it signed in as when it was last tested. */
  account?: string;
  enabled: boolean;
  /** Jira: the projects whose issues are on the board. */
  projects?: string[];
  /** Jira: the transition taken when a ticket is approved, by name. Empty: the one that is plainly "done". */
  doneTransition?: string;
  /** Jira: whether approving a ticket here closes the issue there. */
  closeOnApprove?: boolean;
  /** Jira: when the board was last read from it, and up to which change. */
  lastSyncAt?: number;
  /** The newest `updated` seen: the next read asks for what changed since a little before it. */
  syncedTo?: number;
  /** The first, whole read has been done. */
  filled?: boolean;
  lastError?: string;
  /** Confluence: what was added as sources, to be read again when it changes. */
  watched?: { kind: "space" | "tree"; ref: string; addedAt: number; by: string; lastReadAt?: number; pages?: number }[];
  /** Confluence: pages a person removed from the knowledge base. They are not added again. */
  skipped?: string[];
}

export interface AtlassianData {
  version: 1;
  jira?: AtlassianConnection;
  confluence?: AtlassianConnection;
}

/**
 * Where the connections to Jira and Confluence are kept: a file of its own
 * beside the hub's store, readable by the owner only, the token encrypted
 * where the system can. Not in the hub's store, which rewrites what looks
 * like a secret when it saves, and never in the team bucket: a token acts as
 * the person it belongs to.
 */
export class AtlassianStore {
  data: AtlassianData = { version: 1 };
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<AtlassianData>;
      const read = (c: AtlassianConnection | undefined): AtlassianConnection | undefined =>
        c && typeof c === "object" && typeof c.baseUrl === "string"
          ? { ...c, variant: c.variant === "datacenter" ? "datacenter" : "cloud", token: decryptSecretValue(c.token ?? ""), enabled: c.enabled !== false }
          : undefined;
      this.data = { version: 1, jira: read(raw.jira), confluence: read(raw.confluence) };
    } catch {
      this.data = { version: 1 };
    }
  }

  /** What a call is made with, or nothing when the connection is not complete or is switched off. */
  auth(product: AtlassianProduct, evenIfOff = false): AtlassianAuth | undefined {
    const c = this.data[product];
    if (!c?.token || !c.baseUrl || (!c.enabled && !evenIfOff)) return undefined;
    if (c.variant === "cloud" && !c.email) return undefined;
    return { variant: c.variant, baseUrl: c.baseUrl, email: c.email, token: c.token };
  }

  save(): Promise<void> {
    const sealed = (c: AtlassianConnection | undefined): AtlassianConnection | undefined => (c ? { ...c, token: encryptSecretValue(c.token) } : undefined);
    const content = JSON.stringify({ version: 1, jira: sealed(this.data.jira), confluence: sealed(this.data.confluence) });
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
