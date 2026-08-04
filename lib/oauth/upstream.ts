/**
 * The same-origin proxy base for one provider, absolute because
 * `@ai-sdk/openai-compatible` builds its URL with `new URL`, which throws on a
 * root-relative base.
 *
 * There is no correct origin to fall back to on a server, and inventing one
 * would send a reader's token to whatever host that guess named.
 */
export function upstreamBase(path: string): string {
  if (typeof window === "undefined") {
    throw new Error(
      `Cannot resolve the proxy base for ${path} outside the browser: it is derived from the page's own origin.`
    );
  }

  return `${window.location.origin}/api/upstream/${path}`;
}
