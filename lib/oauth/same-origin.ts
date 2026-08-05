/**
 * `Sec-Fetch-Site` is a forbidden header, so a page cannot forge it — this is
 * the browser's own word for who initiated the request, not the caller's.
 */
const SAME_ORIGIN = "same-origin";

/**
 * Rejects only what a browser vouches is cross-site: another page using this
 * proxy as a CORS relay. A caller that sends no `Sec-Fetch-Site` at all is let
 * through, because it is not a browser and can already reach these APIs
 * directly — the proxy buys it nothing.
 */
export function isForeignOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");

  return site !== null && site !== SAME_ORIGIN;
}
