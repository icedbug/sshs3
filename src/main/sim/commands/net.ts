import type { SimHost } from "../SimHost";
import { fail, lines, NotSimulated, ok, parseArgs, type SimCommand, type SimContext, type SimResult } from "../SimShell";

/**
 * Reaching across the lab's network: names that resolve or do not, ports that
 * answer or do not, and what a web service says. Everything is read from the
 * lab: a service that is down refuses the connection, one that is up but
 * cannot do its job answers with an error.
 */

export interface Reach {
  /** Why it could not be reached, as curl numbers its failures (6: no such name, 7: nothing listens). */
  curlCode?: 6 | 7;
  address?: string;
  status?: number;
  body?: string;
}

/** Asks `host:port` for a path, from a server of the lab. */
export function reach(ctx: Pick<SimContext, "host" | "shell">, name: string, port: number, path: string): Reach {
  const world = ctx.shell.world;
  const local = name === "localhost" || name === "127.0.0.1" || name === ctx.host.name || name === ctx.host.address;
  const address = local ? ctx.host.address : world?.resolve(name);
  if (!address) return { curlCode: 6 };
  const endpoint = world?.endpoints.get(`${name.toLowerCase()}:${port}`) ?? world?.endpoints.get(`${address}:${port}`);
  if (endpoint) return { address, ...endpoint(path, ctx.host) };
  const target: SimHost | undefined = local ? ctx.host : world?.host(address);
  const listener = target?.listening().find((l) => l.port === port && l.proto === "tcp");
  if (!target || !listener) return { curlCode: 7, address };
  const service = target.service(listener.process);
  const sick = service?.healthy?.(target);
  if (sick) return { address, status: 503, body: `${sick}\n` };
  const page = target.facts.get(`http:${port}${path}`) ?? target.facts.get(`http:${port}`);
  return { address, status: 200, body: typeof page === "string" ? page : `OK ${target.name}:${port}\n` };
}

const REASON: Record<number, string> = { 200: "OK", 301: "Moved Permanently", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };

const curl: SimCommand = (ctx, args) => {
  const { flags, values, rest } = parseArgs(args, ["o", "w", "m", "X", "H", "d", "max-time", "connect-timeout", "write-out", "output", "request", "header", "data", "resolve", "cacert", "u"]);
  const raw = rest[0];
  if (!raw) return fail("curl: try 'curl --help' for more information\n", 2);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return fail(`curl: (3) URL rejected: Malformed input to a URL function\n`, 3);
  }
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const got = reach(ctx, url.hostname, port, url.pathname);
  const silent = flags.has("s") || flags.has("silent");
  const showErrors = !silent || flags.has("S") || flags.has("show-error");
  if (got.curlCode === 6) return fail(showErrors ? `curl: (6) Could not resolve host: ${url.hostname}\n` : "", 6);
  if (got.curlCode === 7) return fail(showErrors ? `curl: (7) Failed to connect to ${url.hostname} port ${port} after 0 ms: Couldn't connect to server\n` : "", 7);
  const status = got.status ?? 200;
  const format = values.get("w") ?? values.get("write-out");
  const written = format ? format.replace(/%\{http_code\}/g, String(status)).replace(/%\{remote_ip\}/g, got.address ?? "").replace(/\\n/g, "\n") : "";
  const headOnly = flags.has("I") || flags.has("head");
  const head = lines([`HTTP/1.1 ${status} ${REASON[status] ?? ""}`.trim(), "Server: nginx", "Content-Type: text/plain", `Content-Length: ${Buffer.byteLength(got.body ?? "")}`, ""]);
  const target = values.get("o") ?? values.get("output");
  const body = headOnly ? head : `${flags.has("i") || flags.has("include") ? head : ""}${got.body ?? ""}`;
  const out = target ? written : `${body}${written}`;
  if ((flags.has("f") || flags.has("fail")) && status >= 400) return fail(showErrors ? `curl: (22) The requested URL returned error: ${status}\n` : "", 22);
  return ok(out);
};

const lookup = (ctx: SimContext, name: string): string | undefined => {
  if (name === "localhost") return "127.0.0.1";
  return ctx.shell.world?.resolve(name);
};

const getent: SimCommand = (ctx, args) => {
  if (args[0] !== "hosts" && args[0] !== "ahosts") throw new NotSimulated(`getent ${args[0] ?? ""}`);
  const found = args.slice(1).map((n) => [n, lookup(ctx, n)] as const);
  const out = lines(found.filter(([, a]) => a).map(([n, a]) => `${a!.padEnd(15)} ${n}`));
  return found.every(([, a]) => a) && found.length ? ok(out) : { out, err: "", code: 2 };
};

const hostCmd: SimCommand = (ctx, args) => {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) return fail("Usage: host [-t type] hostname\n", 1);
  const address = lookup(ctx, name);
  return address ? ok(`${name} has address ${address}\n`) : fail("", 1, `Host ${name} not found: 3(NXDOMAIN)\n`);
};

const nslookup: SimCommand = (ctx, args) => {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) return fail("Usage: nslookup hostname\n", 1);
  const address = lookup(ctx, name);
  const head = ["Server:\t\t10.30.0.2", "Address:\t10.30.0.2#53", ""];
  return address
    ? ok(lines([...head, `Name:\t${name}`, `Address: ${address}`, ""]))
    : { out: lines([...head, `** server can't find ${name}: NXDOMAIN`, ""]), err: "", code: 1 };
};

const dig: SimCommand = (ctx, args) => {
  const name = args.find((a) => !a.startsWith("-") && !a.startsWith("+") && !a.startsWith("@") && !/^(A|AAAA|ANY|CNAME|MX|TXT|NS)$/i.test(a));
  if (!name) throw new NotSimulated("dig without a name");
  const address = lookup(ctx, name);
  if (args.includes("+short")) return ok(address ? `${address}\n` : "");
  return ok(
    lines([
      "",
      `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${name}`,
      ";; global options: +cmd",
      ";; Got answer:",
      `;; ->>HEADER<<- opcode: QUERY, status: ${address ? "NOERROR" : "NXDOMAIN"}, id: 4242`,
      `;; flags: qr rd ra; QUERY: 1, ANSWER: ${address ? 1 : 0}, AUTHORITY: 0, ADDITIONAL: 1`,
      "",
      ";; QUESTION SECTION:",
      `;${name}.\t\tIN\tA`,
      ...(address ? ["", ";; ANSWER SECTION:", `${name}.\t300\tIN\tA\t${address}`] : []),
      "",
      ";; SERVER: 10.30.0.2#53(10.30.0.2) (UDP)",
      "",
    ]),
  );
};

const ping: SimCommand = (ctx, args) => {
  const { values, rest } = parseArgs(args, ["c", "W", "i", "w"]);
  const name = rest[0];
  if (!name) return fail("ping: usage error: Destination address required\n", 2);
  const address = lookup(ctx, name);
  if (!address) return fail(`ping: ${name}: Name or service not known\n`, 2);
  const count = Math.max(1, Math.min(5, Number(values.get("c")) || 3));
  const world = ctx.shell.world;
  const up = name === "localhost" || address === ctx.host.address || Boolean(world?.host(address)) || [...(world?.endpoints.keys() ?? [])].some((k) => k.startsWith(`${name.toLowerCase()}:`) || k.startsWith(`${address}:`));
  const replies = up ? Array.from({ length: count }, (_x, i) => `64 bytes from ${address}: icmp_seq=${i + 1} ttl=64 time=0.${21 + i * 3} ms`) : [];
  const result: SimResult = {
    out: lines([
      `PING ${name} (${address}) 56(84) bytes of data.`,
      ...replies,
      "",
      `--- ${name} ping statistics ---`,
      `${count} packets transmitted, ${up ? count : 0} received, ${up ? 0 : 100}% packet loss, time ${(count - 1) * 1001}ms`,
    ]),
    err: "",
    code: up ? 0 : 1,
  };
  return result;
};

/** Whether a port answers: what `nc -zv` is asked. */
const nc: SimCommand = (ctx, args) => {
  const { flags, rest } = parseArgs(args, ["w"]);
  if (!flags.has("z")) throw new NotSimulated("nc without -z");
  const [name, portText] = rest;
  const port = Number(portText);
  if (!name || !port) return fail("usage: nc -zv host port\n", 1);
  const got = reach(ctx, name, port, "/");
  if (got.curlCode === 6) return fail(`nc: getaddrinfo for host "${name}" port ${port}: Name or service not known\n`, 1);
  if (got.curlCode === 7) return fail(`nc: connect to ${name} (${got.address}) port ${port} (tcp) failed: Connection refused\n`, 1);
  return { out: "", err: flags.has("v") ? `Connection to ${name} (${got.address}) ${port} port [tcp/*] succeeded!\n` : "", code: 0 };
};

/** Runs a command on another host in the same SimWorld: `ssh [opts] [user@]host command...`. */
const ssh: SimCommand = (ctx, args) => {
  const world = ctx.shell.world;
  const valueFlags = new Set(["-o", "-i", "-p", "-l", "-F", "-J", "-W", "-c", "-b", "-m", "-S", "-E", "-D", "-L", "-R"]);
  let idx = 0;
  while (idx < args.length && args[idx].startsWith("-")) {
    const a = args[idx];
    if (a === "--") {
      idx += 1;
      break;
    }
    if (valueFlags.has(a)) idx += 2;
    else idx += 1;
  }
  const dest = args[idx];
  if (!dest) return fail("usage: ssh [options] [user@]hostname [command]\n", 255);
  const cmdParts = args.slice(idx + 1);
  const targetRef = dest.includes("@") ? dest.slice(dest.indexOf("@") + 1) : dest;
  const address = lookup(ctx, targetRef);
  if (!address) return fail(`ssh: Could not resolve hostname ${targetRef}: Name or service not known\n`, 255);
  const target = world?.host(targetRef, address);
  if (!target) return fail(`ssh: connect to host ${targetRef} port 22: Connection refused\n`, 255);
  if (!cmdParts.length) return fail(`Pseudo-terminal will not be allocated because stdin is not a terminal.\nUse: ssh ${dest} '<command>'\n`, 1);
  const remoteLine = cmdParts.length === 1 ? cmdParts[0] : cmdParts.map((part) => (/[\s"'$`\\|&;<>()[\]*?~]/.test(part) ? `'${part.replace(/'/g, "'\\''")}'` : part)).join(" ");
  const remoteShell = world!.shell(target);
  const res = remoteShell.run(remoteLine);
  return { out: res.output, err: "", code: res.code };
};

interface FirewallFact {
  active: boolean;
  allow: string[];
}

const firewallRulesOf = (host: SimHost): { active: boolean; allow: string[] } => {
  const fw = host.facts.get("ufw") as FirewallFact | undefined;
  if (fw && typeof fw.active === "boolean" && Array.isArray(fw.allow)) return fw;
  const ports = host.listening().map((l) => `${l.port}/${l.proto}`);
  return { active: false, allow: [...new Set(ports)] };
};

const iptables: SimCommand = (ctx, args) => {
  if (!ctx.root) return fail("iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)\n", 4);
  const { flags, values } = parseArgs(args, ["t", "table"]);
  const table = values.get("t") ?? values.get("table") ?? "filter";
  const fw = firewallRulesOf(ctx.host);
  const showS = flags.has("S");
  const showL = flags.has("L");
  if (!showS && !showL) throw new NotSimulated(`iptables ${args.join(" ")}`);
  if (table !== "filter") {
    return ok(showS ? "-P PREROUTING ACCEPT\n-P INPUT ACCEPT\n-P OUTPUT ACCEPT\n-P POSTROUTING ACCEPT\n" : "Chain PREROUTING (policy ACCEPT)\nChain INPUT (policy ACCEPT)\nChain OUTPUT (policy ACCEPT)\nChain POSTROUTING (policy ACCEPT)\n");
  }
  const policy = fw.active ? "DROP" : "ACCEPT";
  if (showS) {
    const out = [
      `-P INPUT ${policy}`,
      "-P FORWARD DROP",
      "-P OUTPUT ACCEPT",
      "-A INPUT -i lo -j ACCEPT",
      "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    ];
    if (fw.active) {
      for (const r of fw.allow) {
        const [port, proto = "tcp"] = r.split("/");
        out.push(`-A INPUT -p ${proto} --dport ${port} -j ACCEPT`);
      }
    }
    return ok(lines(out));
  }
  const out = [
    `Chain INPUT (policy ${policy})`,
    "target     prot opt source               destination",
    "ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0",
    "ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            ctstate RELATED,ESTABLISHED",
  ];
  if (fw.active) {
    for (const r of fw.allow) {
      const [port, proto = "tcp"] = r.split("/");
      out.push(`ACCEPT     ${proto.padEnd(4)} --  0.0.0.0/0            0.0.0.0/0            ${proto} dpt:${port}`);
    }
  }
  out.push("", "Chain FORWARD (policy DROP)", "target     prot opt source               destination", "", "Chain OUTPUT (policy ACCEPT)", "target     prot opt source               destination");
  return ok(lines(out));
};

const nft: SimCommand = (ctx, args) => {
  if (!ctx.root) return fail("Operation not permitted (you must be root)\n", 1);
  const sub = args.join(" ").trim();
  if (sub === "list tables") return ok("table inet filter\n");
  if (sub !== "list ruleset" && !sub.startsWith("list table")) throw new NotSimulated(`nft ${sub}`);
  const fw = firewallRulesOf(ctx.host);
  const policy = fw.active ? "drop" : "accept";
  const allowLines = fw.active
    ? fw.allow.map((r) => {
        const [port, proto = "tcp"] = r.split("/");
        return `        ${proto} dport ${port} accept`;
      })
    : [];
  return ok(
    lines([
      "table inet filter {",
      "    chain input {",
      `        type filter hook input priority 0; policy ${policy};`,
      "        iifname \"lo\" accept",
      "        ct state established,related accept",
      ...allowLines,
      "    }",
      "    chain forward {",
      "        type filter hook forward priority 0; policy drop;",
      "    }",
      "    chain output {",
      "        type filter hook output priority 0; policy accept;",
      "    }",
      "}",
    ]),
  );
};

export const netCommands: Record<string, SimCommand> = {
  curl,
  getent,
  host: hostCmd,
  nslookup,
  dig,
  ping,
  nc,
  ssh,
  iptables,
  nft,
  wget: () => {
    throw new NotSimulated("wget (use curl)");
  },
};
