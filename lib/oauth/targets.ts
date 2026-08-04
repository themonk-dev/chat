import type { ProviderConfig } from "@ai-oauth-sdk/core";
import { providers } from "@ai-oauth-sdk/core";

/**
 * The security boundary of the proxy: the caller supplies a provider id and a
 * path, never a host or scheme, and every destination is read out of the SDK's
 * own descriptor. `undefined` becomes a uniform 404, so a prober learns nothing.
 */
export function resolveTarget(
  kind: string,
  id: string,
  tail: string[]
): URL | undefined {
  const provider = (providers as Record<string, ProviderConfig | undefined>)[
    id
  ];

  if (!provider) {
    return;
  }

  switch (kind) {
    case "device":
      return asUrl(provider.deviceAuthorizationUrl);
    case "revoke":
      return asUrl(provider.revocationUrl);
    case "token":
      return asUrl(provider.tokenUrl);
    case "upstream":
      return underBase(provider.apiBaseUrl, tail);
    case "userinfo":
      return asUrl(provider.userInfoUrl);
    default:
      return;
  }
}

function asUrl(value: string | undefined): URL | undefined {
  return value ? new URL(value) : undefined;
}

/**
 * Segments pass through unencoded, because re-encoding breaks Code Assist's
 * `/v1internal:loadCodeAssist`. That leaves two guards, both before the join:
 * dot segments are rejected outright (setting `pathname` would normalise them
 * away), and the path is concatenated rather than built with `new URL(rel,
 * base)`, which would read `v1internal:` as a scheme and escape the base.
 */
function underBase(base: string | undefined, tail: string[]): URL | undefined {
  if (!base || tail.length === 0) {
    return;
  }

  for (const part of tail) {
    const decoded = safeDecode(part);

    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return;
    }
  }

  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  const target = new URL(root.href);
  target.pathname = root.pathname + tail.join("/");

  if (
    target.origin !== root.origin ||
    !target.pathname.startsWith(root.pathname)
  ) {
    return;
  }

  return target;
}

/** A malformed escape is not a path we should be forwarding, so it fails closed. */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "..";
  }
}

/**
 * Merged rather than replaced: some descriptors carry their own query (Codex
 * pins a `client_version`), and anything the descriptor set wins.
 */
export function withQuery(target: URL, source: URL): URL {
  const merged = new URL(target);

  for (const [key, value] of source.searchParams) {
    if (!merged.searchParams.has(key)) {
      merged.searchParams.append(key, value);
    }
  }

  return merged;
}
