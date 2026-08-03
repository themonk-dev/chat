import {
  normalizeCodexResponsesBody,
  type ResolvedCredential,
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
import { clientFor } from "./storage";

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
    const tokens = await tokensFor("claude", accessToken);

    return createAnthropic({
      authToken: accessToken,
      baseURL: "/api/upstream/claude",
      // Claude's own descriptor already knows what an OAuth-bearer request
      // needs (the API version, and the beta flag that opts into accepting
      // Authorization at all) — read off it rather than repeating it here.
      headers: proxiedProviders.claude.apiHeaders?.(tokens),
    })(modelId);
  }

  if (id === "openai") {
    const tokens = await tokensFor("openai", accessToken);

    return createOpenAI({
      apiKey: accessToken,
      baseURL: "/api/upstream/openai",
      fetch: codexFetch(tokens),
      // The descriptor's apiHeaders also supplies chatgpt-account-id when
      // the token names one — a subscription token has to name the account
      // it is billed against, and hardcoding just the other two headers
      // silently dropped it.
      headers: proxiedProviders.openai.apiHeaders?.(tokens),
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
 * The full `TokenSet` for a provider, not just the bare access token
 * `sendMessages` hands `modelFor`.
 *
 * Descriptor hooks like `apiHeaders` key off fields — Codex's `accountId`,
 * in particular — that live only on the full record the sign-in flow wrote
 * to storage, not on a token string alone. Reading it back from the same
 * client the rest of the app already uses (`clientFor`, from `storage.ts`)
 * gets the real thing instead of reconstructing a stub that can only ever
 * have the fields already in scope.
 *
 * Falls back to a minimal stand-in when storage has nothing, or has a
 * different token than the one this call is actually using (a refresh
 * mid-flight, say) — attaching another account's `accountId` to this
 * request would be worse than sending none.
 */
async function tokensFor(id: string, accessToken: string): Promise<TokenSet> {
  const stored = await clientFor(id).getTokens();

  if (stored?.accessToken === accessToken) {
    return stored;
  }

  return { accessToken, provider: id, raw: {}, tokenType: "bearer" };
}

type CachedCopilotCredential = {
  credential: ResolvedCredential;
  expiresAt: number;
};

/** One exchange per `ghu_` token; see `copilotCredentialFor` for why. */
const copilotCredentials = new Map<string, CachedCopilotCredential>();

/** Renew this far ahead of the credential's real expiry, to absorb latency. */
const COPILOT_EXPIRY_SKEW_MS = 60_000;

/** A `ghu_` token GitHub never handed an expiry for is assumed valid this long. */
const COPILOT_DEFAULT_TTL_MS = 25 * 60 * 1000;

/**
 * The credential a `ghu_` GitHub token grants is not the one Copilot's API
 * accepts — that has to be exchanged for a short-lived Copilot token first,
 * which is what carries the descriptor's `Copilot-Integration-Id` header
 * alongside it. `exchangeCredential` does both and is read off the
 * descriptor rather than hardcoded, so a change to either lands here for
 * free.
 *
 * The exchange call itself goes straight to `api.github.com`, never through
 * our proxy, so the `ghu_` token travels only to GitHub — but that also
 * means it is the one round trip in this file with no proxy caching or
 * retry logic backing it up, so it is cached here rather than repeated on
 * every message: the resulting token is valid for roughly 25 minutes, and
 * re-exchanging on every turn would multiply both latency and rate-limit
 * exposure on the path we control least.
 */
async function copilotCredentialFor(
  accessToken: string
): Promise<ResolvedCredential> {
  const cached = copilotCredentials.get(accessToken);

  if (cached && Date.now() < cached.expiresAt - COPILOT_EXPIRY_SKEW_MS) {
    return cached.credential;
  }

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

  copilotCredentials.set(accessToken, {
    credential,
    expiresAt: credential.expiresAt ?? Date.now() + COPILOT_DEFAULT_TTL_MS,
  });

  return credential;
}

async function copilotModel(
  modelId: string,
  accessToken: string
): Promise<LanguageModel> {
  const credential = await copilotCredentialFor(accessToken);

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
 * query parameter is added the same way, read off the descriptor's
 * `apiQuery` rather than repeating the `client_version` value it already
 * carries — it is what gates which models the account can see.
 */
function codexFetch(
  tokens: TokenSet,
  inner: typeof fetch = fetch
): typeof fetch {
  return (url, init) => {
    const target = withQuery(url, proxiedProviders.openai.apiQuery?.(tokens));

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

/** Merges `extra` into `url`'s query string, without overriding a param the caller already set. */
function withQuery(
  url: string | URL | Request,
  extra: Record<string, string> | undefined
): string | URL | Request {
  if (typeof url !== "string" || !extra) {
    return url;
  }

  const [path, query] = url.split("?");
  const params = new URLSearchParams(query ?? "");

  for (const [key, value] of Object.entries(extra)) {
    if (!params.has(key)) {
      params.set(key, value);
    }
  }

  return `${path}?${params.toString()}`;
}
