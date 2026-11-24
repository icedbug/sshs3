/**
 * A model that answers from a script, for tests of the agent runtime's three turn loops: OpenAI's
 * chat completions, OpenAI's Responses API and Anthropic's Messages API. It stands in for `fetch`,
 * so no port is opened, and it answers each protocol in that protocol's own stream format. One
 * script can therefore be run against all three loops.
 *
 * The script is a function of the request: it says what the model answers to it (text, tool calls,
 * an answer cut at the output limit, a connection that breaks, an HTTP error).
 */
export type Protocol = "chat" | "responses" | "anthropic";
export const PROTOCOLS: readonly Protocol[] = ["chat", "responses", "anthropic"];

export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ScriptedStep {
  text?: string;
  calls?: ScriptedCall[];
  /** The answer stops at the output limit instead of ending by itself. */
  cutAtLimit?: boolean;
  /**
   * The connection is lost after what was scripted has been sent and before the stream ends:
   * "reset" fails the read as a dropped socket does, "close" ends the stream early without an error.
   */
  breakStream?: "reset" | "close";
  /** An HTTP error instead of a stream. */
  status?: number;
  headers?: Record<string, string>;
  errorBody?: string;
  usage?: { input: number; output: number };
  /** The answer begins with the model's reasoning: a reasoning item (Responses API) or a signed thinking block (Anthropic). */
  reasoning?: boolean;
  /** The text is sent in pieces of this many characters, as a provider streams it. Default: in one piece. */
  piece?: number;
}

/** The text in pieces of `size` characters, or whole. */
function pieces(text: string, size?: number): string[] {
  if (!size || size <= 0) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export interface ScriptedRequest {
  /** 1 for the first request. */
  n: number;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The body as it was sent. */
  raw: string;
  /** The conversation as sent: `messages`, or `input` for the Responses API. */
  items: Array<Record<string, unknown>>;
  /** The last item of the conversation, as JSON. */
  last: string;
  /** How many tool results the conversation holds. */
  toolResults: number;
}

export interface ScriptedModel {
  fetch: typeof fetch;
  requests: ScriptedRequest[];
  /** The model settings that send a run to this stand-in. */
  config(tuning?: Record<string, unknown>): never;
}

export interface ScriptedModelOptions {
  /** Fails the test's run once more requests than this were made: a loop that never ends. Default 200. */
  maxRequests?: number;
  /**
   * Responses API only: the endpoint does not know `include` and refuses a request that carries it,
   * the way a compatible server that lags behind the API does.
   */
  refusesInclude?: boolean;
}

function stream(frames: unknown[], broken?: "reset" | "close"): Response {
  const text = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        if (broken !== "reset") controller.close();
      },
      // Asked for more once what was sent has been read: that read fails, as on a dropped socket.
      pull(controller) {
        controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function toolResults(protocol: Protocol, items: Array<Record<string, unknown>>): number {
  if (protocol === "chat") return items.filter((item) => item.role === "tool").length;
  if (protocol === "responses") return items.filter((item) => item.type === "function_call_output").length;
  return items
    .flatMap((item) => (item.role === "user" && Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
    .filter((block) => block?.type === "tool_result").length;
}

function answer(protocol: Protocol, step: ScriptedStep, n: number, withEncryptedReasoning: boolean): Response {
  const usage = step.usage ?? { input: 1000, output: 20 };
  const calls = (step.calls ?? []).map((call, index) => ({ ...call, id: call.id ?? `call_${n}_${index}` }));
  const broken = step.breakStream;
  if (protocol === "chat") {
    const frames: unknown[] = [];
    if (step.text) for (const part of pieces(step.text, step.piece)) frames.push({ choices: [{ index: 0, delta: { role: "assistant", content: part } }] });
    calls.forEach((call, index) =>
      frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }),
    );
    if (!broken) {
      frames.push({ choices: [{ index: 0, delta: {}, finish_reason: step.cutAtLimit ? "length" : calls.length ? "tool_calls" : "stop" }] });
      frames.push({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
      frames.push("[DONE]");
    }
    return stream(frames, broken);
  }
  if (protocol === "responses") {
    const frames: unknown[] = [];
    if (step.text) for (const part of pieces(step.text, step.piece)) frames.push({ type: "response.output_text.delta", delta: part });
    const output: Array<Record<string, unknown>> = [];
    if (step.reasoning)
      output.push({ type: "reasoning", id: `rs_${n}`, summary: [], ...(withEncryptedReasoning ? { encrypted_content: `opaque-${n}` } : {}) });
    if (step.text)
      output.push({ type: "message", role: "assistant", id: `msg_${n}`, status: step.cutAtLimit ? "incomplete" : "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] });
    for (const call of calls)
      output.push({ type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: "completed" });
    const reported = { input_tokens: usage.input, output_tokens: usage.output };
    if (!broken)
      frames.push(
        step.cutAtLimit
          ? { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output, usage: reported } }
          : { type: "response.completed", response: { status: "completed", output, usage: reported } },
      );
    return stream(frames, broken);
  }
  const frames: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: usage.input, output_tokens: 1 } } }];
  let index = 0;
  if (step.reasoning) {
    frames.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    frames.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: `thought ${n}` } });
    frames.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig-${n}` } });
    frames.push({ type: "content_block_stop", index });
    index++;
  }
  if (step.text) {
    frames.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const part of pieces(step.text, step.piece)) frames.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
    frames.push({ type: "content_block_stop", index });
    index++;
  }
  for (const call of calls) {
    frames.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name } });
    frames.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } });
    frames.push({ type: "content_block_stop", index });
    index++;
  }
  if (!broken) {
    frames.push({ type: "message_delta", delta: { stop_reason: step.cutAtLimit ? "max_tokens" : calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output } });
    frames.push({ type: "message_stop" });
  }
  return stream(frames, broken);
}

export function scriptedModel(
  protocol: Protocol,
  script: (request: ScriptedRequest) => ScriptedStep | Promise<ScriptedStep>,
  options: ScriptedModelOptions = {},
): ScriptedModel {
  const requests: ScriptedRequest[] = [];
  const maxRequests = options.maxRequests ?? 200;
  const fetchImpl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const raw = String(init?.body ?? "{}");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const items = ((protocol === "responses" ? body.input : body.messages) ?? []) as Array<Record<string, unknown>>;
    const request: ScriptedRequest = {
      n: requests.length + 1,
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
      raw,
      items,
      last: JSON.stringify(items.at(-1) ?? null),
      toolResults: toolResults(protocol, items),
    };
    requests.push(request);
    if (requests.length > maxRequests) throw new Error(`The scripted model was asked more than ${maxRequests} times: the run does not end.`);
    // As the Responses API does when nothing is stored (`store: false`): a reasoning item carries its
    // encrypted content only when the request asked for it, and one sent back without it is refused.
    const asksForEncrypted = Array.isArray(body.include) && (body.include as unknown[]).includes("reasoning.encrypted_content");
    if (protocol === "responses" && options.refusesInclude && "include" in body)
      return new Response(
        JSON.stringify({ error: { message: "Unknown parameter: 'include'.", type: "invalid_request_error", param: "include", code: "unknown_parameter" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    if (protocol === "responses" && body.store === false) {
      const bare = items.find((item) => item.type === "reasoning" && typeof item.encrypted_content !== "string");
      if (bare)
        return new Response(
          JSON.stringify({ error: { message: `Item '${String(bare.id)}' of type 'reasoning' was provided without its required encrypted content. Items are not persisted when \`store\` is set to false.`, type: "invalid_request_error" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
    }
    const step = await script(request);
    if (step.status)
      return new Response(step.errorBody ?? `error code: ${step.status}`, { status: step.status, headers: step.headers ?? {} });
    return answer(protocol, step, request.n, asksForEncrypted);
  };
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    requests,
    config: (tuning) =>
      ({
        ...(protocol === "anthropic"
          ? { kind: "anthropic", model: "claude-sonnet-5", apiKey: "test-key-anthropic" } // pragma: allowlist secret
          : protocol === "responses"
            ? { kind: "custom", model: "stand-in", apiKey: "test-key", baseUrl: "https://api.openai.com/v1", apiProtocol: "responses" } // pragma: allowlist secret
            : { kind: "custom", model: "stand-in", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" }),
        ...(tuning ? { tuning } : {}),
      }) as never,
  };
}
