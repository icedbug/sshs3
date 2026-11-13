import http from "node:http";
import type { AddressInfo } from "node:net";
import { callBudget, handleMcpHttp, type McpEndpointDeps } from "../../web/mcp/McpEndpoint";

/**
 * The desktop app answering its owner's own agent over MCP.
 *
 * It listens on 127.0.0.1 and nowhere else, it is off until a person switches
 * it on, and it answers nothing without one of their keys. The endpoint
 * itself is the same one the team server uses, so there is one set of rules
 * for both — including the refusal of any request that carries an Origin,
 * which is what keeps a web page on this machine from reaching it.
 */
export class LocalMcpServer {
  private server?: http.Server;
  private port = 0;
  private readonly rate = callBudget();

  constructor(private readonly deps: Omit<McpEndpointDeps, "enabled" | "rate">) {}

  /** The address a person pastes into their agent, or undefined when it is off. */
  address(): string | undefined {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : undefined;
  }

  running(): boolean {
    return Boolean(this.server);
  }

  /** Switches it on at `port` (0: any free port), or off. Returns the address. */
  async set(on: boolean, port = 0): Promise<string | undefined> {
    if (!on) {
      await this.stop();
      return undefined;
    }
    if (this.server && (port === 0 || port === this.port)) return this.address();
    await this.stop();
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"Something went wrong here."}');
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Loopback only. Not 0.0.0.0: this is for the person at this computer.
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.address();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"Not found"}');
      return;
    }
    let body = "";
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > 1_000_000) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"That is more than this endpoint takes."}');
          return;
        }
        chunks.push(buf);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const answer = await handleMcpHttp(
      { method: req.method || "GET", headers: req.headers as Record<string, string | string[] | undefined>, body },
      {
        ...this.deps,
        rate: this.rate,
        // A name other than this machine's own loopback is not what this listener is for.
        allowedHosts: () => ["127.0.0.1", "localhost"],
        enabled: () => true,
      },
    );
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }
}
