import type { TokenSet } from "@ai-oauth-sdk/core";
import { proxiedProviders } from "./providers";

/** Merges `extra` in without overriding a param the caller already set. */
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

function parseJsonBody(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    return;
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    // A body this cannot read is one it must not rewrite.
  }
}

/**
 * Codex runs stateless and answers a plain Responses body with a silent empty
 * stream. The descriptor's own `transformRequestBody` knows what that implies;
 * this applies it by hand for the one path that uses a stock AI SDK factory.
 */
export function codexFetch(
  tokens: TokenSet,
  inner: typeof fetch = fetch
): typeof fetch {
  return (url, init) => {
    const target = withQuery(url, proxiedProviders.openai.apiQuery?.(tokens));
    const transform = proxiedProviders.openai.transformRequestBody;
    const body = parseJsonBody(init?.body);

    if (!(transform && body)) {
      return inner(target, init);
    }

    const rewritten = transform(
      typeof target === "string" ? target : String(url),
      body,
      tokens
    );

    return inner(target, { ...init, body: JSON.stringify(rewritten) });
  };
}
