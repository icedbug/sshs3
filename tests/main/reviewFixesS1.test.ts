import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCommandSafety } from "../../src/main/ai/hub/CommandSafetyService";
import { maskContext, maskSecrets } from "../../src/main/ai/hub/privacy";
import { FileTools } from "../../src/main/ai/hub/FileTools";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { McpClientManager } from "../../src/main/ai/hub/McpClientManager";
import type { GuardedTarget } from "../../src/main/ai/hub/Notifier";
import { requestJson, setSharedServerCheck, SsrfBlockedError } from "../../src/main/oauth/requestJson";
import { validateOidcIssuerUrl } from "../../src/main/ca/oidcFlow";
import { McpTokenStore } from "../../src/main/web/McpTokenStore";
import { callBudget, handleMcpHttp } from "../../src/main/web/mcp/McpEndpoint";
import type { AgentTask, HubRequest, HubSnapshot, McpServerConfig } from "../../src/shared/types/aiHub";

// pragma: allowlist secret (this file holds fake secrets on purpose)

afterEach(() => {
  setSharedServerCheck(undefined);
  delete process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES;
  vi.restoreAllMocks();
});

const level = (command: string) => analyzeCommandSafety(command).riskLevel;

describe("requestJson: the person's own CA, IdP and cluster on the internal network", () => {
  const privateLookup = async () => [{ address: "10.255.255.1", family: 4 }];

  it("is reached from the desktop app, and from a web server with one account", async () => {
    // Not refused by the address check: what follows is a network error or a timeout, never SsrfBlockedError.
    const err = await requestJson("https://ca.corp.example:9/sign", { method: "GET", timeoutMs: 150, lookup: privateLookup }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SsrfBlockedError);
    expect(validateOidcIssuerUrl("https://10.0.0.5/realms/corp")).toBe("https://10.0.0.5/realms/corp");
  });

  it("is refused on a shared web server unless the administrator allows the private network", async () => {
    setSharedServerCheck(() => true);
    await expect(requestJson("https://ca.corp.example/sign", { method: "GET", timeoutMs: 150, lookup: privateLookup })).rejects.toBeInstanceOf(SsrfBlockedError);
    // A member's own setting does not widen it.
    await expect(
      requestJson("https://ca.corp.example/sign", { method: "GET", timeoutMs: 150, lookup: privateLookup, allowPrivate: true }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(requestJson("https://127.0.0.1:9/x", { method: "GET", timeoutMs: 150 })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(() => validateOidcIssuerUrl("https://10.0.0.5")).toThrow(/private/);

    process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES = "1";
    const err = await requestJson("https://ca.corp.example:9/sign", { method: "GET", timeoutMs: 150, lookup: privateLookup }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SsrfBlockedError);
    expect(validateOidcIssuerUrl("https://10.0.0.5")).toBe("https://10.0.0.5");
  });

  it("never reaches link-local or metadata addresses, on the desktop either", async () => {
    await expect(requestJson("https://169.254.169.254/latest", { method: "GET", timeoutMs: 150 })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(requestJson("https://metadata.google.internal/x", { method: "GET", timeoutMs: 150 })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      requestJson("https://ca.corp.example/x", { method: "GET", timeoutMs: 150, lookup: async () => [{ address: "169.254.169.254", family: 4 }] }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(() => validateOidcIssuerUrl("https://169.254.169.254")).toThrow(/link-local/);
  });
});

describe("database clients: only the connection and output options are read-only", () => {
  it("takes any other option of mysql or mariadb as a change", () => {
    for (const cmd of [
      `mysql -e "select 1" --pager="sh -c id"`,
      `mysql -e "select 1" --init-command="drop table t"`,
      `mysql -e "select 1" --tee=/tmp/out`,
      `mysql --local-infile=1 -e "select 1"`,
      `mysql --defaults-file=/tmp/my.cnf -e "select 1"`,
      `mariadb --pager=less -e "select 1"`,
      `mysqladmin status shutdown`,
      `mysqladmin --defaults-extra-file=/tmp/x status`,
      `clickhouse-client --queries-file /tmp/q.sql -q "select 1"`,
      `cqlsh -f /tmp/x.cql -e "select * from t"`,
      `sqlite3 -init /tmp/x.sql app.db "select 1"`,
      `sqlite3 app.db ".shell id"`,
    ])
      expect([cmd, level(cmd)]).toEqual([cmd, "modify"]);
  });

  it("keeps the read-only forms read-only", () => {
    for (const cmd of [
      `mysql -h db01 -P 3306 -u app -e "select count(*) from users"`,
      `mysql -uapp -psecret --batch --skip-column-names -e "show tables" app`,
      `mysqladmin -h db01 -u root status`,
      `mysqladmin ping`,
      `sqlite3 -readonly app.db "select * from t"`,
      `clickhouse-client -h ch01 --query "select 1"`,
      `cqlsh -u app -k ks -e "select * from t"`,
    ])
      expect([cmd, level(cmd)]).toEqual([cmd, "safe"]);
  });

  it("finds a destructive statement in any of them", () => {
    for (const cmd of [
      `sqlite3 x "delete from t"`,
      `sqlite3 app.db "drop table users"`,
      `mysql --pager=less -e "drop database prod"`,
      `mariadb -e "truncate table t"`,
      `clickhouse-client -q "drop table t"`,
      `cqlsh -e "drop keyspace prod"`,
    ])
      expect([cmd, level(cmd)]).toEqual([cmd, "destructive"]);
  });
});

describe("reading a secret is noticed however it is spelled", () => {
  it("normalises paths and matches globs", () => {
    for (const cmd of [
      "cat /etc/shad*",
      "cat /etc//shadow",
      "cat /etc/../etc/shadow",
      "cat /etc/./shadow",
      "head /etc/sh?dow",
      "cat /proc/self/environ",
      "cat /proc/1/environ",
      "cat /etc/kubernetes/admin.conf",
      "cat ~/.ssh/id_*",
    ]) {
      const a = analyzeCommandSafety(cmd);
      expect([cmd, a.sensitiveRead]).toEqual([cmd, true]);
      expect(a.riskLevel).not.toBe("safe");
    }
  });

  it("knows the commands that print secrets", () => {
    for (const cmd of [
      "printenv",
      "env",
      "kubectl get secret db -o yaml",
      "kubectl -n prod get secrets -ojson",
      "kubectl get secret/db --output=jsonpath={.data}",
      "aws secretsmanager get-secret-value --secret-id prod/db",
      "aws --region eu-north-1 ssm get-parameter --name /db --with-decryption",
      "terraform state pull",
    ]) {
      const a = analyzeCommandSafety(cmd);
      expect([cmd, a.sensitiveRead]).toEqual([cmd, true]);
      expect(a.riskLevel).not.toBe("safe");
    }
  });

  it("leaves ordinary reads alone", () => {
    for (const cmd of ["cat /etc/hosts", "grep foo *", "cat *.log", "kubectl get secrets", "kubectl get pods -o yaml", "env FOO=1 ls", "terraform state list"]) {
      expect([cmd, analyzeCommandSafety(cmd).sensitiveRead ?? false]).toEqual([cmd, false]);
    }
  });
});

describe("masking", () => {
  it("masks a URL password that holds a slash", () => {
    expect(maskSecrets("postgres://user:pa/ss@host/db")).toBe("postgres://user:[redacted]@host/db");
    expect(maskSecrets("redis://:p@ss/w0rd@cache:6379/0")).toBe("redis://:[redacted]@cache:6379/0");
    // A port and a path with an @ in it is not a password.
    expect(maskSecrets("https://example.com:8443/users/@me")).toBe("https://example.com:8443/users/@me");
  });
});

/** Lines that hold a secret, and the secret that must not survive masking. */
const POSITIVE: Array<[line: string, secret: string]> = [
  ["the password is Hunter2-Blue!", "Hunter2-Blue"],
  ["The password is 'correct horse battery staple'", "correct horse battery staple"],
  ["root password was Tr0ub4dor&3 until friday", "Tr0ub4dor&3"],
  ["admin pw: Sommar2024!", "Sommar2024"],
  ["admin pw=Sommar2024", "Sommar2024"],
  ["the api key is ak_9f8e7d6c5b4a3210", "ak_9f8e7d6c5b4a3210"],
  ["the token was XyZ12abcDEF34ghi", "XyZ12abcDEF34ghi"],
  ["VAULT_TOKEN=hvs.CAESIJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5i6", "CAESIJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5i6"],
  ["use hvs.CAESIJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5i6 for the login", "hvs.CAESIJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5i6"],
  ["batch token hvb.AAAAAQJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5", "hvb.AAAAAQJ1u2v3w4x5y6z7a8b9c0d1e2f3g4h5"],
  ["snmp-server community N0rdv1kRO RO", "N0rdv1kRO"],
  ["snmp-server community public RW 10", "public"],
  ["snmp-server host 10.0.0.5 version 2c Tr4pS3cret", "Tr4pS3cret"],
  ["snmp-server host 10.0.0.5 traps version 2c Tr4pS3cret", "Tr4pS3cret"],
  ["rocommunity monitorRO 10.0.0.0/8", "monitorRO"],
  ["snmpwalk -v2c -c n0rdvik 10.0.0.1 system", "n0rdvik"],
  ["snmp_community: n0rdvik-ro", "n0rdvik-ro"],
  ["enable secret 9 $9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM", "nhEmQVczB7dqsO"],
  ["enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0", "hx5rVt7rPNoS4wqbXKX7m0"],
  ["username admin privilege 15 secret 8 $8$dsYGNam3K1SIJO$7nv/35M/qr6t.dVc7UY9zrJDWRVqncHub1PE9UlMQFs", "7nv/35M"],
  ["username ops password 7 0822455D0A16", "0822455D0A16"],
  ["enable password Cisco123", "Cisco123"],
  ["root:$6$rounds=5000$saltsalt$Yh3kMZq1F0bQwZ0dbXw9VQ0c8kT1:19000:0:99999:7:::", "Yh3kMZq1F0bQwZ0dbXw9VQ0c8kT1"],
  ["vpn pre-shared-key: 9f86d081884c7d659a2feaa0c55ad015", "9f86d081884c7d659a2feaa0c55ad015"],
  ["pre-shared-key 0 Ipsec-Sh4red", "Ipsec-Sh4red"],
  ["psk = 0a1b2c3d4e5f60718293", "0a1b2c3d4e5f60718293"],
  ["crypto isakmp key Isakmp2024 address 0.0.0.0", "Isakmp2024"],
  ["wpa_passphrase=GuestWifi2024", "GuestWifi2024"],
  ["export DB_PASSWORD=hunter2secret", "hunter2secret"],
  ["password: hunter2", "hunter2"],
  ["Authorization: Bearer abcd.efgh.ijkl", "abcd.efgh.ijkl"],
  ["curl -u admin:S3cret! https://x", "S3cret"],
  ["postgres://app:s3cretpw@db.internal:5432/app", "s3cretpw"],
  ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["sk_live_abcdefghijklmnop1234", "sk_live_abcdefghijklmnop1234"],
];

/** Lines that hold no secret and must come back exactly as they were. */
const NEGATIVE: string[] = [
  "production passwords: 90 days",
  "Passwords: 12 characters minimum",
  "secrets: weekly on Monday",
  "tokens: rotated every quarter",
  "password: required",
  "the password is stored in the vault",
  "the password is rotated every 90 days",
  "the token is valid for 24 hours",
  "the password is at least 12 characters",
  "Basic auth is disabled on the API gateway",
  "Bearer tokens expire after one hour",
  "pre-shared-key address 0.0.0.0",
  "snmp-server location Datacenter-2",
  "the secret is in /etc/vault/secret.json",
  "Filesystem Size Used Avail Use%",
  "/dev/sda1 100G 41G 59G 41% /",
  "ssh user@host",
  "git clone https://github.com/a/b",
  "mysql -h db -P 3306 -u app",
  "date +%s",
  "retention 7 days for db-01",
  "The token bucket allows 100 requests",
  "password policy: see NV-SEC-001",
  "rotate the password every 90 days",
  "SNMP is used for monitoring the switches",
];

describe("masking corpus", () => {
  it.each(POSITIVE)("masks %s", (line, secret) => {
    expect(maskContext(line)).not.toContain(secret);
    expect(maskContext(line)).toContain("[redacted]");
  });

  it.each(NEGATIVE.map((line) => [line]))("leaves %s alone", (line) => {
    expect(maskContext(line)).toBe(line);
  });

  it("keeps the facts around a masked secret readable", () => {
    expect(maskContext("the password is Hunter2-Blue.")).toBe("the password is [redacted].");
    expect(maskContext("snmp-server community N0rdv1kRO RO")).toBe("snmp-server community [redacted] RO");
    expect(maskContext("production passwords: 90 days, service secrets: 30 days")).toBe("production passwords: 90 days, service secrets: 30 days");
  });

  it("stays fast on long text full of keywords", () => {
    const input = "password is the secret token psk community ".repeat(2000);
    const started = performance.now();
    maskContext(input);
    expect(performance.now() - started).toBeLessThan(300);
  });
});

describe("FileTools: a file is refused for its secrets, not for a byte-order mark", () => {
  const sha256 = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

  async function setupFiles(files: Map<string, string>) {
    const terminals = new TerminalRegistry();
    terminals.register({ id: "ssh-1", label: "web01", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) queueMicrotask(() => terminals.feed("ssh-1", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
    });
    await terminals.arm("ssh-1", "bash");
    const session = terminals.get("ssh-1")!;
    const registered = new Set<string>();
    const bridge = {
      storageRegistry: {
        has: (id: string) => registered.has(id),
        getOrCreate: async (cfg: { id: string }) => {
          registered.add(cfg.id);
          return {};
        },
      },
      sshPtyManager: { getSession: () => ({ config: { host: "10.0.0.20", port: 22, username: "deploy" } }) },
      smartcard: { prepareSftpSmartcardConfig: async (c: unknown) => c, prepareFido2SftpConfig: async (c: unknown) => c },
      fileEditorService: {
        readFile: async (_r: unknown, _p: string, p: string) => ({ content: files.get(p) ?? "" }),
        saveFile: async (_r: unknown, _p: string, p: string, content: string) => void files.set(p, content),
      },
      k8sTerminalManager: { getSession: () => undefined },
    };
    const task = {
      id: "task-s1",
      title: "t",
      startedAs: { agentId: "a", mode: "assisted" },
      mode: "assisted",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 20,
      maxMinutes: 10,
      verification: "not-verified",
      target: { sessionId: "ssh-1", generation: session.generation, label: "web01" },
    } as unknown as AgentTask;
    return { ft: new FileTools(bridge as never, terminals, () => {}), task, dispose: () => terminals.dispose() };
  }

  it("edits a file that starts with a BOM or holds a zero-width non-joiner", async () => {
    const files = new Map<string, string>([
      ["/srv/a.conf", "﻿port=8080\n"],
      ["/srv/b.txt", "Bindestrich‌wort\n"],
    ]);
    const { ft, task, dispose } = await setupFiles(files);
    try {
      for (const [file, from, to] of [
        ["/srv/a.conf", "port=8080", "port=9090"],
        ["/srv/b.txt", "wort", "worte"],
      ]) {
        const before = files.get(file)!;
        await ft.invoke(task, { action: "file-patch", path: file, expectedHash: sha256(before), edits: [{ oldText: from, newText: to }] }, async (c) => {
          c.status = "approved";
        });
        expect(files.get(file)).toBe(before.replace(from, to));
      }
    } finally {
      dispose();
    }
  });

  it("still refuses a file that holds a secret", async () => {
    const files = new Map<string, string>([["/srv/c.env", "DB_PASSWORD=hunter2secret\nport=1\n"]]);
    const { ft, task, dispose } = await setupFiles(files);
    try {
      await expect(
        ft.invoke(task, { action: "file-patch", path: "/srv/c.env", expectedHash: sha256(files.get("/srv/c.env")!), edits: [{ oldText: "port=1", newText: "port=2" }] }, async () => {}),
      ).rejects.toThrow(/redacted secrets/);
    } finally {
      dispose();
    }
  });
});

describe("MCP endpoint: a key's list of tools also holds for resources and prompts", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const SNAP = {
    workspaceServers: [],
    kbPages: [{ id: "p1", title: "Root password rotation", kind: "procedure", body: "secret page text", when: "", targets: [], sources: [], updatedAt: 0 }],
    runbooks: [{ id: "r1", name: "Restore db", description: "", steps: [{ title: "s", command: "x" }], inputs: [] }],
    kbDocuments: [],
    memories: [{ id: "m1", kind: "skill", title: "Skill", text: "skill text", scope: "global" }],
  } as unknown as HubSnapshot;

  async function setup(tools?: string[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-s1-mcp-"));
    dirs.push(dir);
    const tokens = new McpTokenStore(dir);
    await tokens.initialize();
    const made = await tokens.create({ userId: "u1", name: "k", createdBy: "jacob", scopes: ["read"], ...(tools ? { tools } : {}) });
    const request = vi.fn(async (r: HubRequest) =>
      r.action === "kb-page-read" ? ({ reply: { kbPage: (SNAP.kbPages ?? [])[0] } } as unknown as HubSnapshot) : SNAP,
    );
    const deps = { tokens, hubFor: async () => ({ request, actor: "Jacob" }), enabled: () => true, rate: callBudget() };
    const call = async (method: string, params?: Record<string, unknown>) =>
      JSON.parse(
        (
          await handleMcpHttp(
            {
              method: "POST",
              headers: { authorization: `Bearer ${made.token}` },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
            },
            deps,
          )
        ).body,
      ) as { result?: Record<string, unknown>; error?: { message: string } };
    return { call, request };
  }

  it("keeps a key limited to tickets out of the knowledge base", async () => {
    const { call } = await setup(["tickets_list"]);
    expect((await call("resources/list")).result?.resources).toEqual([]);
    expect((await call("resources/templates/list")).result?.resourceTemplates).toEqual([]);
    const read = await call("resources/read", { uri: "sshs3://kb/page/p1" });
    expect(read.error?.message).toMatch(/may only use: tickets_list/);
    expect(JSON.stringify(read)).not.toContain("secret page text");
    const prompts = (await call("prompts/list")).result?.prompts as Array<{ name: string }>;
    expect(prompts.some((p) => p.name.startsWith("runbook:") || p.name.startsWith("skill:"))).toBe(false);
    expect(prompts.some((p) => p.name === "cluster-health-check")).toBe(true);
    expect((await call("prompts/get", { name: "runbook:r1" })).error?.message).toMatch(/kb_read_page/);
    expect((await call("prompts/get", { name: "skill:m1" })).error?.message).toMatch(/kb_read_page/);
  });

  it("lets a key with kb_read_page, or with no list, read them", async () => {
    for (const tools of [["kb_read_page"], undefined]) {
      const { call } = await setup(tools);
      expect(((await call("resources/list")).result?.resources as unknown[]).length).toBeGreaterThan(0);
      const read = await call("resources/read", { uri: "sshs3://kb/page/p1" });
      expect(read.error).toBeUndefined();
      const prompts = (await call("prompts/list")).result?.prompts as Array<{ name: string }>;
      expect(prompts.some((p) => p.name === "runbook:r1")).toBe(true);
    }
  });
});

describe("MCP client: the connection is pinned to the address that was checked", () => {
  it("does not resolve the name again after allow() checked it", async () => {
    const checked: GuardedTarget = { url: new URL("https://mcp.example.com/mcp"), address: "93.184.216.34", family: 4 };
    // A second resolution would answer with the server's own loopback (DNS rebinding).
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const allow = vi.fn(async () => checked);
    const fetchImpl = vi.fn(async () => {
      throw new Error("stop after pinning");
    }) as unknown as typeof fetch;
    const manager = new McpClientManager(fetchImpl, allow, { lookup, guardOptions: () => ({ server: true, allowPrivate: false }) });
    const server = { id: "m1", name: "remote", transport: "http", url: "https://mcp.example.com/mcp", enabled: true } as unknown as McpServerConfig;
    await manager.testAndDiscover(server, 500);
    expect(allow).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    manager.stopAll();
  });

  it("checks under the host's rules, read when used, when allow() does not say which address it checked", async () => {
    let shared = false;
    const lookup = vi.fn(async () => [{ address: "10.1.2.3", family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("stop after the check");
    }) as unknown as typeof fetch;
    const manager = new McpClientManager(fetchImpl, async () => undefined, {
      lookup,
      guardOptions: () => ({ server: shared, allowPrivate: !shared }),
    });
    const server = { id: "m2", name: "lan", transport: "http", url: "https://mcp.lan/mcp", enabled: true } as unknown as McpServerConfig;
    expect((await manager.testAndDiscover(server, 500)).error).toMatch(/stop after the check/);
    shared = true;
    const server2 = { ...server, id: "m3" };
    expect((await manager.testAndDiscover(server2, 500)).error).toMatch(/private network/);
    manager.stopAll();
  });
});
