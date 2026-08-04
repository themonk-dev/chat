import type { TokenSet } from "@ai-oauth-sdk/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { copilotCredentialFor } from "./copilot";
import { wrapCodeAssist } from "./gemini-envelope";
import { resolveGeminiProject } from "./gemini-project";
import { proxiedProviders } from "./providers";
import { withSseTailFlush } from "./sse-tail";
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
 * The closed same-origin proxy's base for one provider, absolute.
 *
 * Absolute, and not merely as a matter of taste. `@ai-sdk/openai-compatible`
 * builds its request URL as ``new URL(`${baseURL}${path}`)``, and `new URL`
 * throws `TypeError: Failed to construct 'URL': Invalid URL` when handed a
 * root-relative base — so with `/api/upstream/xai` the Grok, Qwen and
 * Copilot adapters failed on the first request of every message, before
 * anything reached the network. The other four (`@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, `@ai-sdk/google`, OpenRouter's provider) concatenate
 * strings instead and so worked by luck, which is not a difference worth
 * preserving: one helper puts all seven on the same contract, and the next
 * dependency that switches to `new URL` cannot reintroduce this.
 *
 * The origin is read from the page at call time rather than configured,
 * which is what makes the same build correct on localhost, on a Vercel
 * preview URL and on the production host. This deliberately does not prepend
 * `NEXT_PUBLIC_BASE_PATH`: the proxy route is reached at `/api/upstream/...`
 * from the origin root today (see `lib/oauth/models.ts` and
 * `lib/oauth/gemini-project.ts`, which fetch it that way), and this changes
 * how the URL is *spelled*, not where it points.
 *
 * `modelFor` is only ever called from the browser — `sendMessages` in
 * `./transport`, inside a `ChatTransport` — so there is no correct origin to
 * fall back to on a server, and inventing one would send a reader's token to
 * whatever host that guess named. Saying so is the safer failure.
 */
function upstreamBase(path: string): string {
  if (typeof window === "undefined") {
    throw new Error(
      `Cannot resolve the proxy base for ${path} outside the browser: it is derived from the page's own origin.`
    );
  }

  return `${window.location.origin}/api/upstream/${path}`;
}

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
 *
 * Every one of the seven is given `withSseTailFlush` as its `fetch`. That is
 * not per-provider tuning: the AI SDK's SSE parser has no flush, so a final
 * event that arrives without a trailing blank line is dropped for *any*
 * provider that sends one. Wiring it in seven times rather than once is the
 * cost of `fetch` being the only seam the provider factories expose.
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
      baseURL: upstreamBase("openrouter"),
      fetch: withSseTailFlush(),
    }).chat(modelId);
  }

  if (id === "xai" || id === "qwen") {
    return createOpenAICompatible({
      baseURL: upstreamBase(id),
      fetch: withSseTailFlush(),
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
      baseURL: upstreamBase("claude"),
      fetch: withSseTailFlush(),
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
      baseURL: upstreamBase("openai"),
      fetch: codexFetch(tokens, withSseTailFlush()),
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
      baseURL: upstreamBase("gemini/v1internal"),
      // Outermost, so it sees the stream `wrapCodeAssist` has already
      // unwrapped — the terminator has to land on what the SDK's parser
      // actually reads, not on the enveloped bytes underneath it.
      fetch: withSseTailFlush(
        wrapCodeAssist(project, modelId, withoutApiKeyHeader)
      ),
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

/**
 * Makes the stock Responses adapter's requests look like Codex CLI's.
 *
 * `@ai-sdk/openai` builds a plain Responses API body; Codex's backend runs
 * stateless and answers one with a silent empty stream rather than an error.
 * The descriptor's own `transformRequestBody` is what knows the four things
 * that implies (`store: false`, a configured `reasoning`, an `include` asking
 * for `reasoning.encrypted_content`, and input items stripped of server-side
 * ids) — ordinarily `createAuthenticatedFetch` applies it, and this is that
 * call by hand for the one path that goes through a stock AI SDK factory
 * instead. Reading the hook off the descriptor rather than reaching past it
 * to `normalizeCodexResponsesBody` also inherits its `/responses` path
 * guard, so a `/models` request is not rewritten as if it were a completion.
 *
 * `apiQuery` is read the same way rather than repeating the `client_version`
 * value it already carries — it is what gates which models the account sees.
 *
 * Nothing is added on top of what the descriptor produces, and that is the
 * point. A `session_id` was added here once, on the assumption that Codex
 * required one; it does not, and the backend rejects the whole request with
 * `{"detail":"Unsupported parameter: session_id"}`. Codex CLI does send a
 * `session_id`, but as an HTTP header for cache routing, never as a body
 * parameter — and the SDK descriptor, which owns `originator` and
 * `OpenAI-Beta`, sends none. Anything this request is missing is missing
 * from the descriptor, and belongs there where the CLI, Node and browser
 * runtimes all get it at once.
 */
function codexFetch(
  tokens: TokenSet,
  inner: typeof fetch = fetch
): typeof fetch {
  return (url, init) => {
    const target = withQuery(url, proxiedProviders.openai.apiQuery?.(tokens));
    const transform = proxiedProviders.openai.transformRequestBody;

    if (typeof init?.body !== "string" || !transform) {
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
      body: JSON.stringify(
        transform(
          typeof target === "string" ? target : String(url),
          body,
          tokens
        )
      ),
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
