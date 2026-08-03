import {
  codexClientVersion,
  normalizeCodexResponsesBody,
  type TokenSet,
} from "@ai-oauth-sdk/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { wrapCodeAssist } from "./gemini-envelope";
import { resolveGeminiProject } from "./gemini-project";
import { proxiedProviders } from "./providers";

/**
 * The exact system prompt a Claude Code OAuth token requires.
 *
 * The Messages API refuses an OAuth-bearer request that does not present as
 * Claude Code — "This credential is only authorized for use with Claude
 * Code" — regardless of what the caller actually is. That is a property of
 * the token, not of the caller, so this has to be sent verbatim as the first
 * system message on every request this adapter makes.
 */
export const CLAUDE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Builds an AI SDK model for a provider, pointed at our own proxy.
 *
 * The token is supplied here, in the browser, and travels as an `Authorization`
 * header the proxy forwards without reading. This is what lets the playground
 * claim the credential never reaches a server of ours while still using stock
 * AI SDK adapters — and therefore tool calling, reasoning parts and structured
 * output — rather than a hand-rolled stream reader.
 *
 * Async because Gemini cannot return a model at all until its Code Assist
 * project id is resolved first — an extra round trip (and, on a first
 * sign-in, an onboarding poll) that every other provider skips. `onStatus`
 * is only consulted on that path; the other six ignore it.
 */
export async function modelFor(
  id: string,
  modelId: string,
  accessToken: string,
  onStatus?: (message: string) => void
): Promise<LanguageModel> {
  if (id === "openrouter") {
    return createOpenRouter({
      apiKey: accessToken,
      baseURL: "/api/upstream/openrouter",
    }).chat(modelId);
  }

  if (id === "xai" || id === "qwen") {
    return createOpenAICompatible({
      baseURL: `/api/upstream/${id}`,
      headers: { authorization: `Bearer ${accessToken}` },
      name: id,
    }).chatModel(modelId);
  }

  if (id === "github-copilot") {
    return copilotModel(modelId, accessToken);
  }

  if (id === "claude") {
    return createAnthropic({
      authToken: accessToken,
      baseURL: "/api/upstream/claude",
      // Claude's own descriptor already knows what an OAuth-bearer request
      // needs (the API version, and the beta flag that opts into accepting
      // Authorization at all) — read off it rather than repeating it here.
      headers: proxiedProviders.claude.apiHeaders?.({} as TokenSet),
    })(modelId);
  }

  if (id === "openai") {
    return createOpenAI({
      apiKey: accessToken,
      baseURL: "/api/upstream/openai",
      fetch: codexFetch(),
      headers: {
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
      },
    }).responses(modelId);
  }

  if (id === "gemini") {
    const project = await resolveGeminiProject(accessToken, onStatus);

    return createGoogleGenerativeAI({
      // The SDK insists on an `apiKey` and sends it as `x-goog-api-key`; Code
      // Assist wants the token as `Authorization: Bearer` instead. This
      // value is discarded by `withoutApiKeyHeader` below rather than read —
      // it only exists to satisfy the SDK's own validation.
      apiKey: "unused",
      baseURL: "/api/upstream/gemini/v1internal",
      fetch: wrapCodeAssist(project, modelId, withoutApiKeyHeader),
      headers: { authorization: `Bearer ${accessToken}` },
    })(modelId);
  }

  throw new Error(`No adapter yet for provider: ${id}`);
}

/**
 * Drops the `x-goog-api-key` header `@ai-sdk/google` adds unconditionally.
 *
 * The SDK requires an `apiKey` and always sends it this way; there is no
 * option to turn it off. Code Assist authenticates purely on `Authorization:
 * Bearer`, and Google's API-key stack can reject a request over an invalid
 * key before OAuth is even considered — so the placeholder value has to be
 * removed here rather than merely ignored.
 */
const withoutApiKeyHeader: typeof fetch = (url, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("x-goog-api-key");

  return fetch(url, { ...init, headers });
};

/**
 * The credential a `ghu_` GitHub token grants is not the one Copilot's API
 * accepts — that has to be exchanged for a short-lived Copilot token first,
 * which is what carries the descriptor's `Copilot-Integration-Id` header
 * alongside it. `exchangeCredential` does both and is read off the
 * descriptor rather than hardcoded, so a change to either lands here for
 * free.
 *
 * The exchange call itself goes straight to `api.github.com`, never through
 * our proxy, so the `ghu_` token travels only to GitHub.
 */
async function copilotModel(
  modelId: string,
  accessToken: string
): Promise<LanguageModel> {
  const provider = proxiedProviders["github-copilot"];
  const tokens = {
    accessToken,
    provider: "github-copilot",
    raw: {},
    tokenType: "bearer",
  } as TokenSet;

  const credential = await provider.exchangeCredential?.(tokens, { fetch });

  if (!credential) {
    throw new Error(
      "The github-copilot descriptor has no credential exchange."
    );
  }

  return createOpenAICompatible({
    baseURL: "/api/upstream/github-copilot",
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      ...credential.headers,
    },
    name: "github-copilot",
  }).chatModel(modelId);
}

/**
 * Makes the stock Responses adapter's requests look like Codex CLI's.
 *
 * `@ai-sdk/openai` builds a plain Responses API body; Codex's backend runs
 * stateless and answers one with a silent empty stream rather than an error,
 * so `normalizeCodexResponsesBody` (the SDK's own fix for this, ordinarily
 * applied by `createAuthenticatedFetch`) is applied by hand here instead. A
 * `client_version` query parameter is added the same way, since it is what
 * gates which models the account can see.
 */
function codexFetch(inner: typeof fetch = fetch): typeof fetch {
  return (url, init) => {
    const target = withClientVersion(url);

    if (typeof init?.body !== "string") {
      return inner(target, init);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(init.body);
    } catch {
      return inner(target, init);
    }

    return inner(target, {
      ...init,
      body: JSON.stringify({
        ...normalizeCodexResponsesBody(body),
        session_id: crypto.randomUUID(),
      }),
    });
  };
}

function withClientVersion(
  url: string | URL | Request
): string | URL | Request {
  if (typeof url !== "string") {
    return url;
  }

  const [path, query] = url.split("?");
  const params = new URLSearchParams(query ?? "");

  if (!params.has("client_version")) {
    params.set("client_version", codexClientVersion);
  }

  return `${path}?${params.toString()}`;
}
