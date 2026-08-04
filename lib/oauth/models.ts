import { fetchCodexModels } from "@ai-oauth-sdk/browser";
import type { TokenSet } from "@ai-oauth-sdk/core";
import { copilotCredentialFor } from "@/lib/oauth/copilot";
import { proxiedProviders } from "@/lib/oauth/providers";
import { clientFor } from "@/lib/oauth/storage";

export type Model = { id: string; name: string };

/**
 * What each provider will answer for, and which model to start on.
 *
 * **The first entry of each list is that provider's default** — the model
 * every reader is put on, and billed for, the moment they connect it (see
 * `defaultModelFor` below, and `nextSelection` in
 * `hooks/use-active-chat.tsx`). Order here is behaviour, not presentation:
 * reordering a list for cosmetic reasons silently changes which model the
 * app spends on. `models.test.ts` pins all seven defaults by id so that a
 * reorder has to state the change it is making.
 *
 * That is not hypothetical. Gemini was listed Pro-first here while the
 * predecessor playground lists `gemini-2.5-flash` first, and on Google's
 * free Code Assist tier 2.5 Pro's quota is a small fraction of Flash's: the
 * same account that worked there answered a one-token request here with
 * "You have exhausted your capacity on this model". Nothing about the
 * request was wrong; only the position of two strings.
 *
 * This is the fallback used when a live listing isn't fetched (or the fetch
 * fails) — see `fetchModelsFor` below — but note that the default always
 * comes from here even for the six providers whose list *is* fetched: a
 * live listing replaces what the picker shows, never what a fresh
 * connection starts on. It is also the only source for Gemini, the one
 * provider whose listing this app never even attempts:
 *
 * Code Assist is RPC-shaped, not REST — there is no `/models` to ask
 * (that 404s), and the method that does exist for it,
 * `v1internal:fetchAvailableModels`, accepts the request and answers `403
 * PERMISSION_DENIED`. A gemini-cli OAuth token is not authorised for it.
 * That is a scope wall, not a payload problem: there is no request shape
 * that would make it answer differently, so there is nothing to retry or
 * fix here. Spending a request per sign-in to be told no is worse than
 * writing the two models down — this is the end state, not a stopgap.
 */
const MODELS: Record<string, Model[]> = {
  claude: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  // Flash first: Pro's free-tier Code Assist quota is a small fraction of
  // Flash's, so defaulting to Pro exhausts a free account immediately. This
  // matches the predecessor playground's order.
  gemini: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  "github-copilot": [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  ],
  // Codex first: `gpt-5-codex` is the only model the predecessor playground
  // listed for this provider, and this surface is the Codex backend rather
  // than the general API. The live listing (see `fetchCodexModelList`)
  // replaces both entries for the picker; this order still decides what a
  // fresh connection starts on.
  openai: [
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5", name: "GPT-5" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", name: "GPT-5" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  qwen: [{ id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" }],
  xai: [
    { id: "grok-4", name: "Grok 4" },
    { id: "grok-code-fast-1", name: "Grok Code Fast" },
  ],
};

/**
 * Providers whose listing endpoint an OAuth token from this app can reach.
 * Six of the seven — everything but Gemini, see the comment on `MODELS`.
 */
const FETCHABLE_PROVIDERS = new Set([
  "openrouter",
  "github-copilot",
  "xai",
  "qwen",
  "claude",
  "openai",
]);

export function modelsFor(providerId: string): Model[] {
  return MODELS[providerId] ?? [];
}

/**
 * The model a provider starts on: the first entry of its list in `MODELS`.
 *
 * Kept as "first entry wins" rather than a separate `default` field because
 * a second field can disagree with the list it points into; the position
 * cannot. What stops the position drifting is the pinned-defaults test in
 * `models.test.ts` — see the note on `MODELS` for why that matters.
 */
export function defaultModelFor(providerId: string): string {
  return MODELS[providerId]?.[0]?.id ?? "";
}

/**
 * What to call a model on screen, given the provider it was used through.
 *
 * Falls back to the raw slug, which is the honest answer for a model picked
 * from a live listing this build has never heard of: a slug names the model,
 * and inventing a prettier name would not. Shared by the failure report and by
 * the attribution line under a reply so the two cannot describe the same model
 * differently.
 */
export function modelNameFor(providerId: string, modelId: string): string {
  return (
    modelsFor(providerId).find((model) => model.id === modelId)?.name ?? modelId
  );
}

type UpstreamModel = { id?: unknown; name?: unknown };

/** "grok-code-fast-1" -> "Grok Code Fast 1", for listings that answer with only an id. */
function humanize(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseUpstreamModels(json: unknown): Model[] {
  const list: UpstreamModel[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown })?.data)
      ? ((json as { data: UpstreamModel[] }).data ?? [])
      : [];

  return list
    .filter(
      (entry): entry is UpstreamModel & { id: string } =>
        typeof entry?.id === "string"
    )
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : humanize(entry.id),
    }));
}

/** Alphabetical by name — see `fetchModelsFor` for the one provider this skips. */
function sortByName(models: Model[]): Model[] {
  return [...models].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The full request headers a provider's listing needs — bearer token included,
 * because for one provider the token itself is not the one in hand.
 *
 * Copilot's `/models` sits behind the same gate as its chat/completions: it
 * accepts the short-lived credential `exchangeForCopilotToken` produces, not
 * the raw `ghu_` GitHub OAuth token. Sending the `ghu_` token 401s, and
 * `fetchModelsFor` swallows a 401 the same as any other failure — so the
 * picker silently showed the two-entry static fallback forever while sending
 * worked fine against models the user could not select. The chat path already
 * exchanges correctly (`lib/oauth/adapters.ts`); this one did not, which is
 * why the exchange lives in `./copilot` where both can share one cache. The
 * predecessor playground had no such split: it drove the listing through
 * `createAuthenticatedFetch`, which applies `exchangeCredential` itself.
 *
 * Claude's headers come off its descriptor rather than being written out
 * here for the same reason `adapters.ts` reads them there — the descriptor
 * already knows that the Messages API needs a version header and that an
 * OAuth-bearer request has to opt into the beta that permits `Authorization`
 * at all, and `/models` sits behind that identical gate. Two hand-copied
 * headers is exactly how the Copilot bug above stayed invisible.
 */
async function requestHeadersFor(
  providerId: string,
  accessToken: string
): Promise<Record<string, string>> {
  if (providerId === "github-copilot") {
    const credential = await copilotCredentialFor(accessToken);

    return {
      authorization: `Bearer ${credential.accessToken}`,
      ...credential.headers,
    };
  }

  const authorization = { authorization: `Bearer ${accessToken}` };

  if (providerId === "claude") {
    return {
      ...authorization,
      ...proxiedProviders.claude.apiHeaders?.(
        stubTokens("claude", accessToken)
      ),
    };
  }

  return authorization;
}

/**
 * A minimal `TokenSet` for descriptor hooks that only need the bearer.
 *
 * Claude's `apiHeaders` ignores its argument entirely (its two headers are
 * constants), so nothing is lost by not reading storage here the way
 * `adapters.ts` must for Codex's `accountId`.
 */
function stubTokens(provider: string, accessToken: string): TokenSet {
  return { accessToken, provider, raw: {}, tokenType: "bearer" };
}

/**
 * Codex is the one fetchable provider that doesn't go through the generic
 * bearer-token `GET /models` path below: `fetchCodexModels` is a
 * purpose-built SDK helper that manages its own authenticated request
 * (`createAuthenticatedFetch` under the hood, refreshing the token itself
 * if needed), and the set it returns is gated by the `client_version` the
 * descriptor sends — it reflects what this account can actually use, not a
 * guess. `clientFor("openai")` is the same memoized client
 * `hooks/use-provider-auth.tsx` already drives the device flow through, so
 * this reaches storage the same way a real send would, never a second copy
 * of the token. Only slugs come back, so names are humanized the same as
 * any other slug-only listing.
 */
async function fetchCodexModelList(): Promise<Model[]> {
  const slugs = await fetchCodexModels(clientFor("openai"));
  return slugs.map((slug) => ({ id: slug, name: humanize(slug) }));
}

/**
 * Fetches a provider's live model list, falling back to the static list on
 * any failure — no token, an unfetchable provider, a network error, a
 * non-2xx response, a failed Copilot credential exchange, a thrown error, or
 * a body this app can't parse. A wrong or missing model list should never be
 * the reason sending a message fails; only an actually wrong model id sent to
 * the provider should be.
 *
 * Every path here is keyed by `providerId`, and Codex's delegates to a
 * client independently looked up by that same id — the token used to
 * authenticate a listing request can never belong to a different provider
 * than the one whose route is being called.
 */
export async function fetchModelsFor(
  providerId: string,
  accessToken: string | undefined
): Promise<Model[]> {
  const fallback = modelsFor(providerId);

  if (!accessToken || !FETCHABLE_PROVIDERS.has(providerId)) {
    return fallback;
  }

  try {
    if (providerId === "openai") {
      const models = await fetchCodexModelList();
      return models.length > 0 ? models : fallback;
    }

    const response = await fetch(`/api/upstream/${providerId}/models`, {
      headers: await requestHeadersFor(providerId, accessToken),
    });

    if (!response.ok) {
      return fallback;
    }

    const parsed = parseUpstreamModels(await response.json());
    /*
     * Claude's `/models` answers newest-first, which is a more useful
     * default for a fast-moving catalogue than alphabetical would be — it
     * would otherwise bury "Claude Opus 4.1" under "Claude Haiku 4.5".
     * Every other fetched list is sorted by name for predictable browsing.
     */
    const models = providerId === "claude" ? parsed : sortByName(parsed);

    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}
