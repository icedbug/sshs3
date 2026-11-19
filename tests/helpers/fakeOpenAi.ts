import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

/**
 * A model at the other end of an OpenAI-compatible address, for tests: it answers
 * `POST <url>/chat/completions` as a stream, the way such a service does.
 *
 * What it says is scripted: each step is either a tool call or the text it ends on. Which step
 * comes next is read from the request (how many tool results the conversation holds), so a request
 * that is sent again gets the same answer again. A script that has to look at more than that (a
 * conversation that stops and is taken up again, a second kind of run beside the first) is given as
 * a function of the request instead.
 */
export type FakeModelStep = { tool: string; args: Record<string, unknown> } | { text: string };
/** The request as the model is sent it, as far as a script needs to read it. */
export interface FakeModelRequest {
  messages: Array<{ role: string; content?: unknown }>;
  [key: string]: unknown;
}
export type FakeModelScript = FakeModelStep[] | ((request: FakeModelRequest) => FakeModelStep);

export interface FakeOpenAi {
  /** The address to give as the model's base URL. */
  url: string;
  /** The requests it was sent, parsed. */
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface FakeOpenAiOptions {
  /**
   * Refuses what OpenAI's current models refuse, in OpenAI's own words: `max_tokens` (they take
   * `max_completion_tokens`), a `temperature` other than the default, and `reasoning_effort`.
   */
  strict?: boolean;
  /**
   * Refuses what gpt-6-luna refused when it was first run through the app, in its own words:
   * `max_tokens`, then tools without `reasoning_effort: "none"` (leaving the setting out is not
   * enough), then a `temperature` other than the default while it reasons.
   */
  reasoningModel?: boolean;
  /** Answers this status, with no body worth reading, to the first `times` requests: a provider having a bad moment. */
  flaky?: { status: number; times: number };
  /** Tokens reported per answer. */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** The port to listen on. Any free one when left out. */
  port?: number;
  /** The address to listen on. This machine only (127.0.0.1) when left out. */
  host?: string;
  /** A key and certificate (PEM) to answer over https with. Plain http when left out. */
  tls?: { key: string; cert: string };
}

const refusal = (res: http.ServerResponse, message: string, param: string, code: string): void => {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error", param, code } }));
};

export async function fakeOpenAi(steps: FakeModelScript, options: FakeOpenAiOptions = {}): Promise<FakeOpenAi> {
  const requests: Array<Record<string, unknown>> = [];
  const answer = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-1", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      if (options.flaky && requests.length <= options.flaky.times) {
        res.writeHead(options.flaky.status, { "Content-Type": "text/plain" });
        res.end(`error code: ${options.flaky.status}`);
        return;
      }
      if (options.strict) {
        if ("max_tokens" in body)
          return refusal(res, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens", "unsupported_parameter");
        if (typeof body.temperature === "number" && body.temperature !== 1)
          return refusal(res, `Unsupported value: 'temperature' does not support ${body.temperature} with this model. Only the default (1) value is supported.`, "temperature", "unsupported_value");
        if ("reasoning_effort" in body)
          return refusal(res, "Unrecognized request argument supplied: reasoning_effort", "reasoning_effort", "unknown_parameter");
      }
      if (options.reasoningModel) {
        if ("max_tokens" in body)
          return refusal(res, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "max_tokens", "unsupported_parameter");
        if (Array.isArray(body.tools) && body.tools.length > 0 && body.reasoning_effort !== "none")
          return refusal(res, "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", "reasoning_effort", "unsupported_value");
        if (body.reasoning_effort !== "none" && typeof body.temperature === "number" && body.temperature !== 1)
          return refusal(res, `Unsupported value: 'temperature' does not support ${body.temperature} with this model. Only the default (1) value is supported.`, "temperature", "unsupported_value");
      }
      const messages = (body.messages ?? []) as Array<{ role: string }>;
      const done = messages.filter((m) => m.role === "tool").length;
      const step = typeof steps === "function" ? steps(body as FakeModelRequest) : steps[Math.min(done, steps.length - 1)];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (data: unknown): void => void res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      if ("tool" in step) {
        const args = JSON.stringify(step.args);
        // Sent in two pieces, as a real stream splits the arguments.
        send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${done + 1}`, type: "function", function: { name: step.tool, arguments: args.slice(0, 12) } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const half = Math.ceil(step.text.length / 2);
        send({ choices: [{ index: 0, delta: { role: "assistant", content: step.text.slice(0, half) } }] });
        send({ choices: [{ index: 0, delta: { content: step.text.slice(half) } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      const usage = options.usage ?? { prompt_tokens: 1200, completion_tokens: 40 };
      send({ choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
      send("[DONE]");
      res.end();
    });
  };
  const server = options.tls ? https.createServer(options.tls, answer) : http.createServer(answer);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? "https" : "http"}://${host}:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
