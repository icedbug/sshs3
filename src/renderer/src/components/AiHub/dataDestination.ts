import type { AiProvider } from "@shared/types/ai";

/** Masking is done in the main process (privacy.ts maskContext) on everything sent to a model. */
export const MASKED = "Secrets the app recognises, such as keys, tokens and passwords, are masked first.";

function hostOf(url: string | undefined): string {
  const text = url?.trim();
  if (!text) return "";
  try {
    return new URL(text).host;
  } catch {
    return "";
  }
}

/** One plain line saying where prompts and terminal output go for this provider. */
export function dataDestination(provider: AiProvider, baseUrl?: string): string {
  const what = "Prompts, terminal output you share and tool results are sent to";
  const host = hostOf(baseUrl);
  if (provider === "openai-codex") return `${what} OpenAI under your ChatGPT account. ${MASKED}`;
  if (provider === "anthropic")
    return host && host !== "api.anthropic.com"
      ? `${what} the address set below (${host}). ${MASKED}`
      : `${what} Anthropic's API. ${MASKED}`;
  return `${what} the address set below${host ? ` (${host})` : ""}. A local server keeps them on your network. ${MASKED}`;
}
