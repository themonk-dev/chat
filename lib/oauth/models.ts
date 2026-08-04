import { fetchCodexModels } from "@ai-oauth-sdk/browser";
import type { TokenSet } from "@ai-oauth-sdk/core";
import { copilotCredentialFor } from "@/lib/oauth/copilot";
import { humanize, type Model, modelsFor } from "@/lib/oauth/model-catalog";
import { proxiedProviders } from "@/lib/oauth/providers";
import { clientFor } from "@/lib/oauth/storage";

/** Six of the seven; Gemini has no listing endpoint. See `./model-catalog`. */
const FETCHABLE_PROVIDERS = new Set([
  "openrouter",
  "github-copilot",
  "xai",
  "qwen",
  "claude",
  "openai",
]);

type UpstreamModel = { id?: unknown; name?: unknown };

function entriesOf(json: unknown): UpstreamModel[] {
  if (Array.isArray(json)) {
    return json;
  }

  const wrapped = (json as { data?: unknown })?.data;

  return Array.isArray(wrapped) ? (wrapped as UpstreamModel[]) : [];
}

function parseUpstreamModels(json: unknown): Model[] {
  return entriesOf(json)
    .filter(
      (entry): entry is UpstreamModel & { id: string } =>
        typeof entry?.id === "string"
    )
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : humanize(entry.id),
    }));
}

function sortByName(models: Model[]): Model[] {
  return [...models].sort((a, b) => a.name.localeCompare(b.name));
}

function stubTokens(provider: string, accessToken: string): TokenSet {
  return { accessToken, provider, raw: {}, tokenType: "bearer" };
}

/**
 * Copilot's `/models` sits behind the same gate as its completions: it wants
 * the exchanged credential, not the raw `ghu_` token. Claude's two headers come
 * off its descriptor, which already knows the OAuth-bearer beta flag.
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
 * Codex has a purpose-built SDK helper rather than a bearer-token `GET /models`:
 * the set it returns is gated by the `client_version` the descriptor sends.
 */
async function fetchCodexModelList(): Promise<Model[]> {
  const slugs = await fetchCodexModels(clientFor("openai"));

  return slugs.map((slug) => ({ id: slug, name: humanize(slug) }));
}

/** Claude answers newest-first, which beats alphabetical for a fast catalogue. */
async function fetchUpstreamModels(
  providerId: string,
  accessToken: string
): Promise<Model[]> {
  const response = await fetch(`/api/upstream/${providerId}/models`, {
    headers: await requestHeadersFor(providerId, accessToken),
  });

  if (!response.ok) {
    return [];
  }

  const parsed = parseUpstreamModels(await response.json());

  return providerId === "claude" ? parsed : sortByName(parsed);
}

/**
 * Falls back to the static catalogue on every failure: a wrong model list must
 * never be the reason sending fails.
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
    const models =
      providerId === "openai"
        ? await fetchCodexModelList()
        : await fetchUpstreamModels(providerId, accessToken);

    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}
