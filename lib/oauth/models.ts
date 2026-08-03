import { fetchCodexModels } from "@ai-oauth-sdk/browser";
import { clientFor } from "@/lib/oauth/storage";

export type Model = { id: string; name: string };

/**
 * What each provider will answer for, and which model to start on.
 *
 * This is the fallback used when a live listing isn't fetched (or the fetch
 * fails) — see `fetchModelsFor` below. It is also the only source for
 * Gemini, the one provider whose listing this app never even attempts:
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
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  "github-copilot": [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  ],
  openai: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
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

export function defaultModelFor(providerId: string): string {
  return MODELS[providerId]?.[0]?.id ?? "";
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
 * Headers a provider's listing request needs beyond the bearer token.
 *
 * Copilot's chat/completions and its `/models` listing both expect the
 * short-lived token `exchangeForCopilotToken` produces, not the raw GitHub
 * OAuth token this app currently has in hand — that exchange is the other
 * task's `lib/oauth/adapters.ts` to wire up. Sent with just the GitHub token,
 * this request most likely 401s, which `fetchModelsFor` treats the same as
 * any other failure: fall back to the static list. The headers are supplied
 * anyway so the call is ready the moment the token it needs exists.
 *
 * Claude's API requires `anthropic-version` on every endpoint, and an
 * OAuth-bearer request additionally needs to opt into the beta that allows
 * it at all — the same two headers the Messages API needs, since `/models`
 * sits behind the same gate.
 */
function headersFor(providerId: string): Record<string, string> {
  if (providerId === "github-copilot") {
    return {
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
    };
  }
  if (providerId === "claude") {
    return {
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    };
  }
  return {};
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
 * non-2xx response, a thrown error, or a body this app can't parse. A wrong
 * or missing model list should never be the reason sending a message fails;
 * only an actually wrong model id sent to the provider should be.
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
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...headersFor(providerId),
      },
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
