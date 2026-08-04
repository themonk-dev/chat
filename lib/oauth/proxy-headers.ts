/**
 * Anthropic's token endpoint refuses a browser-like `User-Agent` and dresses
 * the refusal as `429 rate_limit_error`. Set rather than only deleted, so this
 * does not fall back to whatever the runtime would send.
 */
export const PROXY_USER_AGENT =
  "ai-oauth-sdk-playground/1.0 (+https://ai-oauth.themonk.dev)";

/**
 * Browser-only and hop-by-hop headers. They describe a cross-origin request
 * from a page, which is not what leaves this proxy, and some providers reject a
 * request that claims otherwise.
 */
export const STRIPPED_REQUEST_HEADERS = [
  "origin",
  "referer",
  "cookie",
  "host",
  "user-agent",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "anthropic-dangerous-direct-browser-access",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  // The runtime negotiates and decodes for us; forwarding the page's
  // preference makes the two disagree and the body arrives unreadable.
  "accept-encoding",
];

/**
 * Every response here answers exactly one caller's credentialed request. A CDN
 * keys on URL and method alone, so an upstream `public, max-age` forwarded
 * verbatim would serve one reader's answer to everybody else.
 */
export const PRIVATE_CACHE_CONTROL = "private, no-store";

/**
 * `content-encoding`/`content-length` describe bytes already decoded by the
 * time we see them. The cache directives are removed rather than overridden
 * because CDNs read the vendor-prefixed ones in preference to `cache-control`.
 */
export const STRIPPED_RESPONSE_HEADERS = [
  "set-cookie",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
  "content-length",
  "cache-control",
  "cdn-cache-control",
  "vercel-cdn-cache-control",
  "surrogate-control",
  "expires",
  "pragma",
  "age",
];
