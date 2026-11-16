import { describe, expect, it } from "vitest";
import { UpstreamHttpError, friendlyProviderError } from "../../src/main/ai/hub/DirectAgentRuntime";

const ollama = { kind: "custom", model: "qwen2.5-coder:14b", baseUrl: "http://127.0.0.1:11434/v1/" } as const;
const remote = { kind: "custom", model: "gpt-4.1", apiKey: "k", baseUrl: "https://llm.example.com/v1" } as const;
const anthropic = { kind: "anthropic", model: "claude-x", apiKey: "k" } as const;

describe("friendlyProviderError", () => {
  it("names the address and what to do when nothing listens there", () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
    });
    expect(friendlyProviderError(refused, ollama)).toBe(
      "No model answered at http://127.0.0.1:11434/v1. Start Ollama, or choose another model in AI settings.",
    );
  });
  it.each(["ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"])("maps %s on a remote address", (code) => {
    const error = Object.assign(new Error(`getaddrinfo ${code} llm.example.com`), { code });
    expect(friendlyProviderError(error, remote)).toBe(
      "No model answered at https://llm.example.com/v1. Check the address and your network, or choose another model in AI settings.",
    );
  });
  it("maps a bare fetch failure", () => {
    expect(friendlyProviderError(new TypeError("fetch failed"), remote)).toMatch(/^No model answered at https:\/\/llm\.example\.com\/v1\./);
  });
  it.each([401, 403])("says the key was refused on %i", (status) => {
    const error = new UpstreamHttpError(status, "https://api.anthropic.com/v1/messages", `Anthropic API (${status}): invalid x-api-key`);
    expect(friendlyProviderError(error, anthropic)).toBe(
      `The API key was refused at https://api.anthropic.com (${status}). Enter a valid key in AI settings.`,
    );
  });
  it("names the model on a 404 that says the model is not there", () => {
    const error = new UpstreamHttpError(404, "http://127.0.0.1:11434/v1/chat/completions", 'Model API (404): model "qwen2.5-coder:14b" not found, try pulling it first');
    expect(friendlyProviderError(error, ollama)).toBe(
      'The model "qwen2.5-coder:14b" was not found at http://127.0.0.1:11434/v1. Choose another model in AI settings.',
    );
  });
  it("leaves every other failure as the provider said it", () => {
    expect(friendlyProviderError(new UpstreamHttpError(404, "x", "Model API (404): page not found"), remote)).toBe(
      "Model API (404): page not found",
    );
    expect(friendlyProviderError(new UpstreamHttpError(500, "x", "Model API (500): overloaded"), remote)).toBe(
      "Model API (500): overloaded",
    );
    expect(friendlyProviderError("plain text", remote)).toBe("plain text");
  });
  it("gives a text the chat recognises as about the model", () => {
    const hint = /AI settings|settings first|API key|No model answered|endpoint missing|key was refused/i;
    expect(friendlyProviderError(new TypeError("fetch failed"), ollama)).toMatch(hint);
    expect(friendlyProviderError(new UpstreamHttpError(401, "x", "nope"), remote)).toMatch(hint);
  });
});
