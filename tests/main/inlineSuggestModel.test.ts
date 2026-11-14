import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The Ctrl+K suggestion asked a reasoning model at its default effort and gave
 * it five seconds: the answer was always the canned one, after a five-second
 * wait.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const d of disposals.splice(0)) await d();
  vi.unstubAllGlobals();
});

async function hub(config: Record<string, unknown>) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-inline-model-"));
  // A ChatGPT sign-in of this workspace's own, with a token that does not expire during the test.
  const jwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.x`;
  await fs.writeFile(path.join(dir, "ai-auth.json"), JSON.stringify({ tokens: { access_token: jwt, refresh_token: "r" } })); // pragma: allowlist secret
  const h = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), workspaceServers: async () => [] } as never,
    dir,
  );
  disposals.push(async () => {
    await h.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await h.initialize();
  await h.request({ action: "configure", config: { enabled: true, ...config } } as never);
  return h;
}

const answer = JSON.stringify({ command: "tail -n 20 /var/log/nginx/error.log", explanation: "The last 20 lines of the nginx error log." });

describe("a suggestion from the model", () => {
  it("asks a reasoning model for low effort: one command does not need long thinking", async () => {
    const h = await hub({ provider: "openai-codex", model: "gpt-6.1-sol" });
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (!String(url).endsWith("/responses")) return new Response("{}", { status: 404 });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: answer })}\n\ndata: [DONE]\n\n`, { status: 200 });
      }),
    );
    const s = (await h.request({ action: "inline-suggest", prompt: "last 20 lines of the nginx error log", shell: "bash" })).reply!.inlineSuggestion!;
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(s.source).toBe("model");
    expect(s.command).toBe("tail -n 20 /var/log/nginx/error.log");
  });

  it("waits longer than five seconds for the answer, and still gives up", async () => {
    const h = await hub({ provider: "openai-compatible", model: "local", baseUrl: "http://127.0.0.1:9/v1" });
    let delay = 8000;
    let asked = 0;
    // The request reads its settings first: the clock is moved only once the model has been asked.
    const untilAsked = async (n: number) => {
      while (asked < n) await new Promise((r) => setImmediate(r));
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            asked++;
            const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 })), delay);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Eight seconds: the measured time of the model was 5.5 to 11.4 s, and five was the old limit.
    const slow = h.request({ action: "inline-suggest", prompt: "last 20 lines of the nginx error log", shell: "bash" });
    await untilAsked(1);
    await vi.advanceTimersByTimeAsync(8100);
    expect((await slow).reply!.inlineSuggestion).toMatchObject({ source: "model", command: "tail -n 20 /var/log/nginx/error.log" });

    // A model that does not answer at all is not waited for without end.
    delay = 120_000;
    const never = h.request({ action: "inline-suggest", prompt: "show disk usage", shell: "bash" });
    await untilAsked(2);
    await vi.advanceTimersByTimeAsync(15_100);
    expect((await never).reply!.inlineSuggestion!.source).toBe("fallback");
  });
});
