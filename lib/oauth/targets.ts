import type { ProviderConfig } from "@ai-oauth-sdk/core";
import { providers } from "@ai-oauth-sdk/core";

/**
 * Turns a request path into the upstream URL it is allowed to reach.
 *
 * This is the security boundary of the whole proxy. The caller supplies a
 * provider id and, for API calls, a path below that provider's base — never a
 * host, never a scheme, never a full URL. Every destination is read back out of
 * the SDK's own descriptor, so the set of hosts this app can be made to talk to
 * is fixed at build time and is exactly the set the SDK already ships.
 *
 * Returns `undefined` for anything that does not resolve, which the caller
 * turns into a 404. Silence rather than an explanation: a prober learns nothing
 * about which providers exist from a uniform miss.
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
 * Joins a caller-supplied path onto the provider's API base, then checks the
 * result did not climb out of it.
 *
 * Segments are passed through exactly as received rather than re-encoded. They
 * arrive already percent-encoded, and re-encoding them corrupts any path that
 * legitimately contains a reserved character: Google's Code Assist addresses
 * its methods as `/v1internal:loadCodeAssist`, and escaping that colon to `%3A`
 * turns every call into a 404.
 *
 * Which leaves two things to guard, both done before the join rather than after:
 *
 * `.` and `..` are rejected outright. Setting `pathname` normalises dot
 * segments, so a `..` would silently climb out of the base and the containment
 * check below would see an already-collapsed path.
 *
 * The join builds the pathname by concatenation instead of `new URL(rel, base)`.
 * That constructor reads anything before the first slash as a scheme, so
 * `v1internal:loadCodeAssist` parses as an absolute URL and escapes the base
 * entirely — the very reason the encoding was there in the first place.
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
 * Copies the caller's query string onto the resolved target.
 *
 * Some descriptors carry their own query — Codex pins a `client_version` — so
 * the caller's params are merged in rather than replacing what is already
 * there. Anything the descriptor set wins, since that is the SDK's own
 * requirement rather than the page's.
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
