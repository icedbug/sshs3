import type { SimHost } from "../SimHost";
import { fail, ok, type SimCommand } from "../SimShell";

/**
 * nginx as far as an operator meets it: a configuration that is read when it
 * starts or reloads, that it refuses when it is wrong, and that it goes on
 * running the old version of until then.
 */

export const NGINX_CONF = "/etc/nginx/nginx.conf";
export const NGINX_DIR = "/etc/nginx/conf.d";

/** The configuration files nginx reads, in the order it reads them. */
export const nginxFiles = (host: SimHost): string[] => [
  NGINX_CONF,
  ...host
    .list(NGINX_DIR)
    .filter((e) => !e.dir && e.name.endsWith(".conf"))
    .map((e) => `${NGINX_DIR}/${e.name}`)
    .sort(),
];

/** The whole configuration as one text, comments gone: what is in force once it is loaded. */
export const nginxText = (host: SimHost): string =>
  nginxFiles(host)
    .map((f) => host.read(f)?.content ?? "")
    .join("\n")
    .replace(/#.*$/gm, "");

/** Why nginx will not take the configuration as it is written, in its own words, or nothing. */
export function nginxProblem(host: SimHost): string | undefined {
  if (!host.read(NGINX_CONF)) return `nginx: [emerg] open() "${NGINX_CONF}" failed (2: No such file or directory)`;
  const zones = new Set<string>();
  const uses: { zone: string; file: string; line: number }[] = [];
  for (const file of nginxFiles(host)) {
    let depth = 0;
    const text = host.read(file)?.content ?? "";
    const rows = text.split("\n");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].replace(/#.*$/, "").trim();
      if (!row) continue;
      if (!/[;{}]$/.test(row)) return `nginx: [emerg] directive "${row.split(/\s+/)[0]}" is not terminated by ";" in ${file}:${i + 1}`;
      depth += (row.match(/\{/g) ?? []).length - (row.match(/\}/g) ?? []).length;
      if (depth < 0) return `nginx: [emerg] unexpected "}" in ${file}:${i + 1}`;
      const zone = /^limit_req_zone\s.*\bzone=([\w-]+):/.exec(row);
      if (zone) zones.add(zone[1]);
      const use = /^limit_req\s+zone=([\w-]+)/.exec(row);
      if (use) uses.push({ zone: use[1], file, line: i + 1 });
      const cert = /^ssl_certificate(?:_key)?\s+([^;\s]+);/.exec(row);
      if (cert && !host.read(cert[1])) return `nginx: [emerg] cannot load certificate "${cert[1]}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory) in ${file}:${i + 1}`;
    }
    if (depth > 0) return `nginx: [emerg] unexpected end of file, expecting "}" in ${file}:${rows.length}`;
  }
  const lost = uses.find((u) => !zones.has(u.zone));
  if (lost) return `nginx: [emerg] zero size shared memory zone "${lost.zone}" in ${lost.file}:${lost.line}`;
  return undefined;
}

/** The configuration the running nginx goes by: taken in at start and at reload. */
export const nginxRunning = (host: SimHost): string => (host.service("nginx")?.state === "active" ? String(host.facts.get("nginx.running") ?? "") : "");

export function addNginx(host: SimHost): void {
  host.packages.nginx = "1.24.0-2ubuntu7.1";
  host.addService({
    name: "nginx",
    description: "A high performance web server and a reverse proxy server",
    command: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;",
    ports: [
      { proto: "tcp", port: 80 },
      { proto: "tcp", port: 443 },
    ],
    check: nginxProblem,
    applied: (h) => void h.facts.set("nginx.running", nginxText(h)),
  });
}

const nginx: SimCommand = (ctx, args) => {
  const host = ctx.host;
  if (!host.service("nginx")) return fail("bash: nginx: command not found\n", 127);
  if (args[0] === "-v" || args[0] === "-V") return fail("nginx version: nginx/1.24.0 (Ubuntu)\n", 0);
  const why = nginxProblem(host);
  const verdict = why ? `${why}\nnginx: configuration file ${NGINX_CONF} test failed\n` : `nginx: the configuration file ${NGINX_CONF} syntax is ok\nnginx: configuration file ${NGINX_CONF} test is successful\n`;
  if (args[0] === "-t") return { out: "", err: verdict, code: why ? 1 : 0 };
  if (args[0] === "-T") {
    if (why) return fail(verdict, 1);
    return { out: nginxFiles(host).map((f) => `# configuration file ${f}:\n${host.read(f)?.content ?? ""}`).join("\n"), err: verdict, code: 0 };
  }
  if (args[0] === "-s" && args[1] === "reload") {
    if (!ctx.root) return fail('nginx: [alert] kill(1, 1) failed (1: Operation not permitted)\n', 1);
    if (host.service("nginx")?.state !== "active") return fail('nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)\n', 1);
    const wrong = host.reload("nginx");
    return wrong ? fail(`${wrong}\n`, 1) : ok();
  }
  return fail("nginx: invalid option\n", 1);
};

export const nginxCommands: Record<string, SimCommand> = { nginx };
