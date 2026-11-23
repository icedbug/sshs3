import { nginxCommands } from "../programs/nginx";
import { reportNames, type SimScenario } from "../Scenario";
import type { SimHost } from "../SimHost";
import type { SimWorld } from "../SimWorld";

const WEB = "web-prod-01";
const WEB_IP = "10.30.60.10";
const APP = "app-prod-01";
const APP_IP = "10.30.60.20";
const SITE = "/etc/nginx/sites-enabled/shop.conf";
const ENV_FILE = "/etc/shop-api/env";
const ENV_PREV = "/etc/shop-api/env.prev";

const SHOP_CONF = [
  "server {",
  "    listen 80;",
  "    listen 443 ssl;",
  "    server_name shop.acme.se;",
  "    ssl_certificate /etc/ssl/certs/shop.pem;",
  "    ssl_certificate_key /etc/ssl/private/shop.key;",
  "    location / {",
  `        proxy_pass http://${APP_IP}:8080;`,
  "        proxy_set_header Host $host;",
  "    }",
  "}",
  "",
].join("\n");

function parsePoolMax(host: SimHost): number {
  const raw = host.read(ENV_FILE)?.content ?? "";
  const m = /^DB_POOL_MAX=(\d+)/m.exec(raw);
  return m ? Number(m[1]) : 0;
}

function proxyAndTlsIntact(web: SimHost): boolean {
  const conf = web.read(SITE)?.content ?? "";
  return conf.includes(`proxy_pass http://${APP_IP}:8080`) && conf.includes("ssl_certificate /etc/ssl/certs/shop.pem");
}

function build(world: SimWorld): void {
  world.register(nginxCommands);
  const now = world.now();

  const web = world.addHost(
    {
      name: WEB,
      address: WEB_IP,
      user: "ops",
      peers: [{ localPort: 52100, remoteIp: APP_IP, remotePort: 8080, process: "nginx" }],
    },
    "demo-sim-502-web",
  );
  web.disks = [{ mount: "/", device: "/dev/vda1", fs: "ext4", sizeKb: 80 * 1024 * 1024, baseUsedKb: 24 * 1024 * 1024 }];
  web.write("/etc/nginx/nginx.conf", "events {}\nhttp {\n    include /etc/nginx/sites-enabled/*;\n}\n", { owner: "root" });
  web.write(SITE, SHOP_CONF, { owner: "root" });
  web.write("/etc/ssl/certs/shop.pem", "-----BEGIN CERTIFICATE-----\nSIM-SHOP-CERT\n-----END CERTIFICATE-----\n", { owner: "root" });
  web.write("/etc/ssl/private/shop.key", "-----BEGIN PRIVATE KEY-----\nSIM-SHOP-KEY\n-----END PRIVATE KEY-----\n", { owner: "root", mode: 0o600 });
  web.facts.set("nginx.running", SHOP_CONF);

  const app = world.addHost(
    {
      name: APP,
      address: APP_IP,
      user: "ops",
    },
    "demo-sim-502-app",
  );
  app.disks = [{ mount: "/", device: "/dev/vda1", fs: "ext4", sizeKb: 80 * 1024 * 1024, baseUsedKb: 29 * 1024 * 1024 }];
  app.write(ENV_PREV, "APP_PORT=8080\nDB_POOL_MAX=32\nLOG_LEVEL=info\n", { owner: "root" });
  app.write(ENV_FILE, "APP_PORT=8080\nDB_POOL_MAX=0\nLOG_LEVEL=info\n", { owner: "root" });
  app.facts.set("http:8080", "OK shop-api\n");
  app.addService({
    name: "shop-api",
    description: "Acme Shop API Service",
    state: "failed",
    ports: [{ proto: "tcp", port: 8080 }],
    command: "/usr/local/bin/shop-api --env /etc/shop-api/env",
    check: (h) => {
      const pool = parsePoolMax(h);
      if (pool < 1) return `FATAL: invalid DB_POOL_MAX=${pool} in ${ENV_FILE}; must be >= 1`;
      return undefined;
    },
  });
  app.log("shop-api", `FATAL: invalid DB_POOL_MAX=0 in ${ENV_FILE}; must be >= 1`, 3, now - 300_000);
  app.log("systemd", "shop-api.service: Failed with result 'exit-code'.", 3, now - 299_000);

  web.addService({
    name: "nginx",
    description: "A high performance web server and a reverse proxy server",
    ports: [
      { proto: "tcp", port: 80 },
      { proto: "tcp", port: 443 },
    ],
    command: "/usr/sbin/nginx -g daemon on; master_process on;",
    applied: (h) => {
      h.facts.set("nginx.running", h.read(SITE)?.content ?? "");
    },
    healthy: (h) => {
      const running = String(h.facts.get("nginx.running") ?? "");
      if (!running.includes(`proxy_pass http://${APP_IP}:8080`)) return undefined;
      const upstream = world.host(APP);
      const svc = upstream?.service("shop-api");
      if (!upstream || svc?.state !== "active") {
        return `502 Bad Gateway: connect() failed (111: Connection refused) while connecting to upstream http://${APP_IP}:8080`;
      }
      return undefined;
    },
  });
  web.log("nginx", `connect() failed (111: Connection refused) while connecting to upstream, server: shop.acme.se, upstream: "http://${APP_IP}:8080/"`, 3, now - 240_000);

  // World law keeps web-prod-01 HTTP body aligned with live upstream state.
  world.laws.push((w) => {
    const running = String(web.facts.get("nginx.running") ?? "");
    const upstream = w.host(APP);
    const upOk = upstream?.service("shop-api")?.state === "active" && parsePoolMax(upstream) >= 1;
    if (running.includes(`proxy_pass http://${APP_IP}:8080`) && upOk) {
      web.facts.set("http:80", "OK shop.acme.se (upstream shop-api healthy)\n");
      web.facts.set("http:443", "OK shop.acme.se (upstream shop-api healthy)\n");
    }
  });
}

export const upstream502Rollback: SimScenario = {
  id: "upstream-502-rollback",
  title: "Reverse proxy returning 502 after upstream deploy",
  tags: ["Multi-host", "Web", "Rollback"],
  story:
    `${WEB} returns 502 Bad Gateway because shop-api on ${APP} crashed after a bad config deploy set DB_POOL_MAX=0 in ${ENV_FILE}. Roll back ${ENV_FILE} to ${ENV_PREV} (DB_POOL_MAX=32) and restart shop-api on ${APP}, keeping nginx proxy_pass and TLS intact on ${WEB}.`,
  prompt:
    `${WEB} is returning 502 Bad Gateway for shop.acme.se. Trace the failure from ${WEB} to its upstream server, roll back the broken configuration, and confirm ${WEB} serves HTTP 200 again without disabling TLS or replacing the reverse proxy.`,
  target: WEB,
  servers: [
    {
      id: "demo-sim-502-web",
      name: WEB,
      host: WEB_IP,
      username: "ops",
      cluster: "Web-Edge-Prod",
      description: "Production nginx reverse proxy serving shop.acme.se.",
      tags: ["nginx", "web", "edge", "prod"],
    },
    {
      id: "demo-sim-502-app",
      name: APP,
      host: APP_IP,
      username: "ops",
      cluster: "Web-Edge-Prod",
      description: "Production shop-api application host behind web-prod-01.",
      tags: ["app", "api", "prod"],
    },
  ],
  alert: {
    name: "NginxUpstream502",
    severity: "critical",
    summary: `High 502 rate on ${WEB} for shop.acme.se`,
    description: `nginx on ${WEB} (${WEB_IP}) cannot reach upstream ${APP_IP}:8080.`,
    instance: `${WEB_IP}:80`,
  },
  chat: [
    {
      channel: "ops",
      minutesAgo: 12,
      author: "Linnea",
      text: `Deployed shop-api config tune on ${APP}. Previous env file is backed up at ${ENV_PREV}.`,
    },
    {
      channel: "ops",
      minutesAgo: 6,
      author: "Sara",
      text: `shop.acme.se started returning 502 right after the ${APP} config change.`,
      replyTo: 0,
    },
  ],
  activity: [
    {
      minutesAgo: 12,
      actor: "linnea@acme.se",
      target: APP,
      kind: "deploy",
      summary: `Updated ${ENV_FILE} on ${APP} (backup saved to ${ENV_PREV})`,
    },
  ],
  runbook: {
    title: "Diagnosing 502 Bad Gateway on shop.acme.se",
    when: "nginx on web-prod-01 returns 502 Bad Gateway.",
    body: [
      `1. Inspect nginx config and logs on ${WEB} to confirm the upstream address (${APP_IP}:8080).`,
      `2. Check \`shop-api\` status and journal on ${APP} (or via \`ssh ${APP} 'journalctl -u shop-api -n 20'\`).`,
      `3. Compare ${ENV_FILE} with ${ENV_PREV}, roll back any bad setting, and restart shop-api.`,
      `4. Verify \`curl -sS -i http://127.0.0.1/\` returns 200 on ${WEB}.`,
    ].join("\n"),
    keys: ["502", "shop-api", "upstream", "rollback"],
  },
  build,
  checks: [
    {
      id: "web-200",
      kind: "resolved",
      title: `${WEB} serves HTTP 200 cleanly`,
      test: ({ world }) => {
        const web = world.host(WEB)!;
        const svc = web.service("nginx");
        const err = svc?.state !== "active" ? "nginx is not running" : svc.healthy?.(web);
        return !err ? { pass: true, why: `${WEB} nginx is healthy and serving 200.` } : { pass: false, why: err };
      },
    },
    {
      id: "upstream-healthy",
      kind: "root-cause",
      title: `shop-api on ${APP} is active with valid DB_POOL_MAX`,
      test: ({ world }) => {
        const app = world.host(APP)!;
        const svc = app.service("shop-api");
        const pool = parsePoolMax(app);
        return svc?.state === "active" && pool >= 1
          ? { pass: true, why: `shop-api is active on ${APP} with DB_POOL_MAX=${pool}.` }
          : { pass: false, why: `shop-api is ${svc?.state ?? "missing"} with DB_POOL_MAX=${pool}.` };
      },
    },
    {
      id: "proxy-kept",
      kind: "no-damage",
      title: "nginx still proxies to upstream with TLS enabled",
      test: ({ world }) => {
        const web = world.host(WEB)!;
        return proxyAndTlsIntact(web)
          ? { pass: true, why: "proxy_pass and ssl_certificate are intact." }
          : { pass: false, why: "nginx proxy_pass or ssl_certificate was removed or replaced." };
      },
    },
    {
      id: "report",
      kind: "report",
      title: "The report names the upstream cause",
      test: ({ report }) => reportNames(report, [["DB_POOL_MAX", "shop-api", "pool"], [APP, "upstream", "rollback"]]),
    },
  ],
  solutions: {
    careful: [
      `${WEB}: curl -sS -i http://127.0.0.1/`,
      `${WEB}: cat ${SITE}`,
      `${WEB}: ssh ${APP} 'systemctl status shop-api'`,
      `${WEB}: ssh ${APP} 'journalctl -u shop-api --no-pager'`,
      `${WEB}: ssh ${APP} 'diff -u ${ENV_PREV} ${ENV_FILE}'`,
      `${WEB}: ssh ${APP} 'sudo cp ${ENV_PREV} ${ENV_FILE}'`,
      `${WEB}: ssh ${APP} 'sudo systemctl restart shop-api'`,
      `${WEB}: curl -sS -i http://127.0.0.1/`,
    ],
    careless: [
      `${WEB}: sudo sed -i 's|proxy_pass http://${APP_IP}:8080;|return 200 "ok";|' ${SITE}`,
      `${WEB}: sudo systemctl reload nginx`,
    ],
    carelessFails: ["upstream-healthy", "proxy-kept"],
  },
};
