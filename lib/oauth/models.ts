export type Model = { id: string; name: string };

/**
 * What each provider will answer for, and which model to start on.
 *
 * This is the fallback used when a live listing isn't fetched (or the fetch
 * fails) — see `fetchModelsFor` below. It is also the only source for the
 * three providers whose listing endpoint an OAuth token from this app can
 * never reach:
 *
 * - Gemini's Code Assist answers `400 Unknown name "metadata"` and then `403
 *   PERMISSION_DENIED` — there is no listing endpoint this token reaches.
 * - Codex (the `openai` provider id here — ChatGPT sign-in, not an API key)
 *   has no public listing endpoint at `chatgpt.com/backend-api/codex` either.
 * - Claude's Messages API has no `/models` endpoint reachable with an
 *   OAuth-bearer token (`anthropic-beta: oauth-2025-04-20`); it is scoped to
 *   `user:inference` and nothing that lists a catalogue.
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

/** Providers whose listing endpoint an OAuth token from this app can reach. */
const FETCHABLE_PROVIDERS = new Set([
  "openrouter",
  "github-copilot",
  "xai",
  "qwen",
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
 */
function headersFor(providerId: string): Record<string, string> {
  if (providerId === "github-copilot") {
    return {
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
    };
  }
  return {};
}

/**
 * Fetches a provider's live model list through the OAuth proxy, falling back
 * to the static list on any failure — no token, an unfetchable provider, a
 * network error, a non-2xx response, or a body this app can't parse. A wrong
 * or missing model list should never be the reason sending a message fails;
 * only an actually wrong model id sent to the provider should be.
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
    const response = await fetch(`/api/upstream/${providerId}/models`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...headersFor(providerId),
      },
    });

    if (!response.ok) {
      return fallback;
    }

    const models = parseUpstreamModels(await response.json());
    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}
