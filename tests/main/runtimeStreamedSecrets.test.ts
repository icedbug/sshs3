// Secrets in an answer while it streams. The runtime's StreamingSecretMasker decides what each
// `message.delta` carries, and the hub passes it to the windows as it is (host.delta) and keeps a
// copy of it. Nothing that masking the whole answer hides may reach either, at any piece size.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import type { AgentTask } from "../../src/shared/types/aiHub";
import { DirectAgentRuntime, resetCircuitBreakers, retryPolicy, StreamingSecretMasker } from "../../src/main/ai/hub/DirectAgentRuntime";
import { boundedContext, maskSecrets } from "../../src/main/ai/hub/privacy";
import { PROTOCOLS, scriptedModel, type Protocol, type ScriptedStep } from "../helpers/scriptedModel";

beforeEach(() => {
  retryPolicy.attempts = 0;
  retryPolicy.baseDelayMs = 1;
  resetCircuitBreakers();
});
afterEach(() => {
  retryPolicy.attempts = 3;
  retryPolicy.baseDelayMs = 1000;
});

const b64 = (n: number, seed: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  let x = seed.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
};

const PEM_LINES = Array.from({ length: 150 }, (_, i) => (i === 140 ? `LEAKEDKEYLINE${b64(51, "k")}` : b64(64, `l${i}`)));
const JWT = `eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJ${b64(1400, "p")}.${b64(86, "s")}`;

const CASES: Array<{ name: string; text: string; secret: string }> = [
  {
    name: "a mysql password more than 128 characters after mysql",
    secret: "S3cr3tPassw0rd",
    text:
      "Connect with:\n\nmysql -h db-primary.internal.example.com -u app_rw --ssl-ca=/etc/ssl/db/ca.pem --ssl-cert=/etc/ssl/db/client-cert.pem --ssl-key=/etc/ssl/db/client-key.pem -pS3cr3tPassw0rd prod_db\n\nThen run the query.",
  },
  {
    name: "curl -u at the end of a long command line",
    secret: "Gr4f4n4Adm1nPw",
    text:
      "Check it with:\n\ncurl -sS --retry 3 --connect-timeout 5 -H 'Accept: application/json' -H 'X-Request-Id: 7f3c9a11' https://grafana.internal.example.com/api/health -u admin:Gr4f4n4Adm1nPw\n\nIt should say ok.",
  },
  {
    name: "a docker config auth of 300 characters",
    secret: b64(300, "auth").slice(0, 40),
    text: `Your ~/.docker/config.json:\n\n{\n  "auths": {\n    "123456789012.dkr.ecr.eu-west-1.amazonaws.com": {\n      "auth": "${b64(300, "auth")}"\n    }\n  }\n}\n\nThat is all.`,
  },
  {
    name: "a JWT of more than 1,024 characters with no keyword before it",
    secret: JWT.slice(0, 60),
    text: `The proxy forwards it as\n\nX-Goog-IAP-JWT-Assertion: ${JWT}\n\nand the backend checks it.`,
  },
  {
    name: "a private key of more than 8,192 characters",
    secret: "LEAKEDKEYLINE",
    text: `Here is the key:\n\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_LINES.join("\n")}\n-----END RSA PRIVATE KEY-----\n\nKeep it safe.`,
  },
  {
    name: "a chpasswd heredoc of more than 128 characters",
    secret: "Alic3-Secret-1",
    text:
      "Set them with:\n\nchpasswd <<EOF\nalice:Alic3-Secret-1\nbob:B0b-Secret-22\ncarol:Car0l-Secret-333\ndave:Dav3-Secret-4444\nerin:Er1n-Secret-55555\nfrank:Fr4nk-Secret-666666\ngrace:Gr4ce-Secret-7777777\nEOF\n\nDone.",
  },
];
const PIECES = [1, 4, 17, 1000];

const disposals: Array<() => Promise<unknown> | unknown> = [];
let hub: HubService;
const toWindows: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "streamed-secrets-"));
  hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
      delta: (piece: Record<string, unknown>) => toWindows.push(piece),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
});
afterAll(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

let taskCount = 0;
function newTask(): AgentTask {
  const task = {
    id: `run-${++taskCount}`, title: "t", mode: "advice", status: "running",
    messages: [{ id: "m1", role: "user", text: "Show me", at: 1 }],
    changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 0, maxMinutes: 0, verification: "not-verified",
  } as unknown as AgentTask;
  hub.store.data.tasks.push(task);
  return task;
}

async function runScript(protocol: Protocol, steps: (n: number) => ScriptedStep): Promise<RunEvent[]> {
  const model = scriptedModel(protocol, (request) => steps(request.n));
  const broker = async (req: Record<string, unknown>) => (req.action === "context" ? {} : { exitCode: 0, output: "" });
  const runtime = new DirectAgentRuntime(broker as never, undefined, model.fetch);
  const events: RunEvent[] = [];
  await runtime.start(newTask(), model.config(), (event) => events.push(event));
  return events;
}

interface Seen {
  streamed: string;
  deltas: number;
  windows: string;
  keptMidRun: string[];
  keptAfterStop: string;
  keptCompleted: string;
  end?: RunEvent;
}

/** The run's events as the hub takes them: once stopped before it says it ended, once to its end. */
function throughHub(events: RunEvent[]): Seen {
  const stopped = newTask();
  const windowsFrom = toWindows.length;
  const keptMidRun: string[] = [];
  for (const event of events) {
    if (/^run\.(completed|failed|cancelled)$/.test(event.type)) continue;
    hub.event(stopped, event);
    keptMidRun.push(stopped.messages.map((m) => m.text).join("\n"));
  }
  const windows = toWindows.slice(windowsFrom).filter((p) => p.type === "message.delta").map((p) => String(p.delta)).join("");
  // The person pressed Stop after the answer streamed and before the run said it had completed.
  hub.event(stopped, { type: "run.cancelled" } as RunEvent);
  const completed = newTask();
  for (const event of events) hub.event(completed, event);
  const deltas = events.filter((e) => e.type === "message.delta");
  return {
    streamed: deltas.map((e) => e.delta ?? "").join(""),
    deltas: deltas.length,
    windows,
    keptMidRun,
    keptAfterStop: stopped.messages.at(-1)?.text ?? "",
    keptCompleted: completed.messages.at(-1)?.text ?? "",
    end: events.find((e) => /^run\.(completed|failed|cancelled)$/.test(e.type)),
  };
}

describe.each(PROTOCOLS)("a secret in an answer that streams (%s)", (protocol) => {
  describe.each(PIECES)("in pieces of %i characters", (piece) => {
    it.each(CASES)("$name reaches neither the windows nor the kept answer", async ({ text, secret }) => {
      expect(maskSecrets(text)).not.toContain(secret);
      const seen = throughHub(await runScript(protocol, () => ({ text, piece })));
      expect(seen.end?.type).toBe("run.completed");
      expect(seen.end?.output).not.toContain(secret);
      expect(seen.streamed).not.toContain(secret);
      expect(seen.windows).not.toContain(secret);
      for (const kept of seen.keptMidRun) expect(kept).not.toContain(secret);
      expect(seen.keptAfterStop).not.toContain(secret);
      // Shown piece by piece, the answer is what masking it whole gives, and that is what is kept.
      expect(seen.streamed).toBe(maskSecrets(text));
      expect(seen.windows).toBe(seen.streamed);
      expect(seen.keptAfterStop).toBe(boundedContext(maskSecrets(text), 128_000));
      expect(seen.keptCompleted).toBe(boundedContext(maskSecrets(text), 128_000));
    });
  });
});

describe.each(PROTOCOLS)("a secret cut in two by the output limit (%s)", (protocol) => {
  it.each([
    { name: "a private key", cutAt: (t: string) => t.indexOf("LEAKEDKEYLINE") - 30 },
    { name: "a JWT", cutAt: (t: string) => t.indexOf("eyJ") + 700 },
    { name: "a chpasswd heredoc", cutAt: (t: string) => t.indexOf("bob:") + 3 },
  ])("$name is masked whole when the answer goes on in the next turn", async ({ name, cutAt }) => {
    const { text, secret } = CASES.find((c) => c.name.includes(name.replace(/^a /, "")))!;
    const at = cutAt(text);
    const seen = throughHub(
      await runScript(protocol, (n) => (n === 1 ? { text: text.slice(0, at), piece: 7, cutAtLimit: true } : { text: text.slice(at), piece: 7 })),
    );
    expect(seen.end?.type).toBe("run.completed");
    expect(seen.end?.output).not.toContain(secret);
    expect(seen.streamed).not.toContain(secret);
    expect(seen.windows).not.toContain(secret);
    for (const kept of seen.keptMidRun) expect(kept).not.toContain(secret);
    expect(seen.keptAfterStop).not.toContain(secret);
    expect(seen.streamed).toBe(maskSecrets(text));
  });
});

describe("StreamingSecretMasker", () => {
  const streamed = (text: string, piece: number): { out: string; parts: string[] } => {
    const masker = new StreamingSecretMasker();
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += piece) {
      const out = masker.push(text.slice(i, i + piece));
      if (out) parts.push(out);
    }
    const rest = masker.flush();
    if (rest) parts.push(rest);
    return { out: parts.join(""), parts };
  };

  it("shows the answer line by line while it streams", () => {
    const text = "First line of the answer.\nSecond line.\nThird line, the last.";
    const { parts } = streamed(text, 3);
    expect(parts).toEqual(["First line of the answer.\n", "Second line.\n", "Third line, the last."]);
  });

  it.each([1, 3, 1000])("masks a value on the line after its keyword (pieces of %i)", (piece) => {
    const text = "Set it in the file:\npassword:\nHunt3r-2-Secret\nThen restart.\n";
    expect(maskSecrets(text)).not.toContain("Hunt3r-2-Secret");
    const { out } = streamed(text, piece);
    expect(out).not.toContain("Hunt3r-2-Secret");
    expect(out).toBe(maskSecrets(text));
  });

  it("does not show a token whose Bearer ended the line before, though it cannot take that line back", () => {
    const text = "Send the header\nAuthorization: Bearer\nabcDEF123ghiJKL456mno\nand it works.\n";
    expect(maskSecrets(text)).not.toContain("abcDEF123ghiJKL456mno");
    const { out } = streamed(text, 2);
    expect(out).not.toContain("abcDEF123ghiJKL456mno");
    expect(out).toContain("[redacted]");
  });

  it("passes on a line longer than it holds back in parts, without cutting a secret", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const text = `${words} --password Sup3r-Secret-Value ${words}\nend\n`;
    const { out, parts } = streamed(text, 5);
    expect(parts.length).toBeGreaterThan(3);
    expect(out).not.toContain("Sup3r-Secret-Value");
    expect(out).toBe(maskSecrets(text));
  });

  it("does not cut a long line inside a quoted value", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const value = Array.from({ length: 80 }, (_, i) => `part${i}`).join(" ");
    const text = `${words} password = "${value}" ${words}\n`;
    expect(maskSecrets(text)).not.toContain("part40");
    const { out } = streamed(text, 5);
    expect(out).not.toContain("part40");
    expect(out).toBe(maskSecrets(text));
  });

  it("shows only the placeholder for a PGP key block that never ends", () => {
    const text = `Key:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${b64(64, "a")}\nnot base64 but still hidden\n${b64(64, "b")}`;
    const { out } = streamed(text, 9);
    expect(out).toBe(maskSecrets(text));
    expect(out).toBe("Key:\n[private key redacted]");
  });

  it("goes on with the text after a BEGIN marker that only names a key", () => {
    const text = "A key file starts with -----BEGIN RSA PRIVATE KEY----- and ends with its END line.\nNext line.\n";
    const { out } = streamed(text, 4);
    expect(out).toBe(maskSecrets(text));
  });

  it("hides an encrypted key's header and body, the END line too", () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF\n\n${b64(64, "e")}\n${b64(20, "f")}==\n-----END RSA PRIVATE KEY-----\ndone\n`;
    const { out } = streamed(text, 6);
    expect(out).toBe("[private key redacted]\ndone\n");
    expect(out).toBe(maskSecrets(text));
  });
});
