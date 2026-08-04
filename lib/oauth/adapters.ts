import type { TokenSet } from "@ai-oauth-sdk/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { codexFetch } from "./codex-request";
import { copilotCredentialFor } from "./copilot";
import { wrapCodeAssist } from "./gemini-envelope";
import { resolveGeminiProject } from "./gemini-project";
import { proxiedProviders } from "./providers";
import { withSseTailFlush } from "./sse-tail";
import { clientFor } from "./storage";
import { upstreamBase } from "./upstream";

/**
 * The Messages API refuses an OAuth-bearer request that does not present as
 * Claude Code, so this has to be sent verbatim on every request.
 */
export const CLAUDE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * `@ai-sdk/google` always sends its `apiKey` as `x-goog-api-key`, and Google's
 * API-key stack can reject the placeholder before OAuth is considered.
 */
const withoutApiKeyHeader: typeof fetch = (url, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("x-goog-api-key");

  return fetch(url, { ...init, headers });
};

/**
 * Descriptor hooks key off fields — Codex's `accountId` — that live only on the
 * stored record. Falls back to a stub when storage holds a different token,
 * since another account's `accountId` would be worse than none.
 */
async function tokensFor(id: string, accessToken: string): Promise<TokenSet> {
  const stored = await clientFor(id).getTokens();

  if (stored?.accessToken === accessToken) {
    return stored;
  }

  return { accessToken, provider: id, raw: {}, tokenType: "bearer" };
}

function openRouterModel(modelId: string, accessToken: string): LanguageModel {
  return createOpenRouter({
    apiKey: accessToken,
    baseURL: upstreamBase("openrouter"),
    fetch: withSseTailFlush(),
  }).chat(modelId);
}

function openAiCompatibleModel(
  id: string,
  modelId: string,
  accessToken: string
): LanguageModel {
  return createOpenAICompatible({
    baseURL: upstreamBase(id),
    fetch: withSseTailFlush(),
    headers: { authorization: `Bearer ${accessToken}` },
    name: id,
  }).chatModel(modelId);
}

async function copilotModel(
  modelId: string,
  accessToken: string
): Promise<LanguageModel> {
  const credential = await copilotCredentialFor(accessToken);

  return createOpenAICompatible({
    baseURL: upstreamBase("github-copilot"),
    fetch: withSseTailFlush(),
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      ...credential.headers,
    },
    name: "github-copilot",
  }).chatModel(modelId);
}

async function claudeModel(
  modelId: string,
  accessToken: string
): Promise<LanguageModel> {
  const tokens = await tokensFor("claude", accessToken);

  return createAnthropic({
    authToken: accessToken,
    baseURL: upstreamBase("claude"),
    fetch: withSseTailFlush(),
    headers: proxiedProviders.claude.apiHeaders?.(tokens),
  })(modelId);
}

async function codexModel(
  modelId: string,
  accessToken: string
): Promise<LanguageModel> {
  const tokens = await tokensFor("openai", accessToken);

  return createOpenAI({
    apiKey: accessToken,
    baseURL: upstreamBase("openai"),
    fetch: codexFetch(tokens, withSseTailFlush()),
    headers: proxiedProviders.openai.apiHeaders?.(tokens),
  }).responses(modelId);
}

async function geminiModel(
  modelId: string,
  accessToken: string,
  onStatus: ((message: string) => void) | undefined
): Promise<LanguageModel> {
  const project = await resolveGeminiProject(accessToken, onStatus);

  return createGoogleGenerativeAI({
    // Discarded by `withoutApiKeyHeader`; it only satisfies the SDK's own
    // validation, since Code Assist authenticates on the bearer alone.
    apiKey: "unused",
    baseURL: upstreamBase("gemini/v1internal"),
    // Outermost, so the terminator lands on the stream `wrapCodeAssist` has
    // already unwrapped rather than on the enveloped bytes underneath.
    fetch: withSseTailFlush(
      wrapCodeAssist(project, modelId, withoutApiKeyHeader)
    ),
    headers: { authorization: `Bearer ${accessToken}` },
  })(modelId);
}

/**
 * Builds an AI SDK model pointed at our own proxy, with the token supplied here
 * in the browser and forwarded as a header the proxy never reads.
 *
 * `withSseTailFlush` is wired in seven times because `fetch` is the only seam
 * the provider factories expose, and the SDK's SSE parser has no flush.
 */
export function modelFor(
  id: string,
  modelId: string,
  accessToken: string,
  onStatus?: (message: string) => void
): Promise<LanguageModel> {
  switch (id) {
    case "claude":
      return claudeModel(modelId, accessToken);

    case "gemini":
      return geminiModel(modelId, accessToken, onStatus);

    case "github-copilot":
      return copilotModel(modelId, accessToken);

    case "openai":
      return codexModel(modelId, accessToken);

    case "openrouter":
      return Promise.resolve(openRouterModel(modelId, accessToken));

    case "qwen":
    case "xai":
      return Promise.resolve(openAiCompatibleModel(id, modelId, accessToken));

    default:
      return Promise.reject(new Error(`No adapter yet for provider: ${id}`));
  }
}
