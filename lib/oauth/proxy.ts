import { publicClientSecrets } from "@ai-oauth-sdk/core";

/**
 * Rebuilds the request against the resolved upstream URL.
 *
 * Browser-only and hop-by-hop headers are dropped rather than passed through.
 * `origin`, `referer` and the `sec-fetch-*` family describe a browser making a
 * cross-origin request, which is not what is happening once the call leaves
 * here, and some providers reject a request that claims otherwise. Claude is
 * the clearest case: its Messages API wants
 * `anthropic-dangerous-direct-browser-access` from a page and nothing of the
 * sort from a server.
 *
 * The `Authorization` header is forwarded untouched and never read. That is the
 * whole point of this file.
 *
 * On the way back, every response — proxied, errored or substituted — is
 * stamped `private, no-store` and stripped of the upstream's cache directives.
 * See PRIVATE_CACHE_CONTROL.
 */
export async function forward(
  request: Request,
  target: URL
): Promise<Response> {
  const headers = new Headers(request.headers);

  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }

  headers.set("user-agent", PROXY_USER_AGENT);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody
    ? await withClientSecret(request, target, headers)
    : null;

  const upstream = await fetch(target, {
    body,
    cache: "no-store",
    headers,
    method: request.method,
    redirect: "manual",
  });

  const out = new Headers(upstream.headers);

  for (const name of STRIPPED_RESPONSE_HEADERS) {
    out.delete(name);
  }

  /*
   * `upstream.body` is handed back untouched rather than buffered. Every
   * provider answers a chat with server-sent events, and reading the body to
   * completion here would hold the whole reply until the last token before the
   * page saw the first.
   */
  return uncacheable(
    blockNotice(upstream, target) ??
      new Response(upstream.body, {
        headers: out,
        status: upstream.status,
        statusText: upstream.statusText,
      })
  );
}

/**
 * Marks a response as the answer to one caller and nobody else.
 *
 * Exported because the route handler answers two requests without reaching
 * `forward()` at all — a bot-gate refusal and an unknown route — and "every
 * response from this proxy is uncacheable" is a weaker claim if it has to be
 * read as "every response except those two". The 403 in particular is a
 * per-caller verdict, and a 404 is cacheable by heuristic under RFC 9111 even
 * with no cache directive on it.
 *
 * Mutates and returns the same response rather than rebuilding one: the body
 * may be a live upstream stream, and copying it would mean reading it.
 */
export function uncacheable(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

  return response;
}

/**
 * Turns an upstream bot-block into something a reader can act on.
 *
 * Some providers sit behind bot management that refuses a proxy outright, and
 * the refusal is an HTML challenge page rather than an API error. Passed
 * through untouched it lands in the chat thread as a wall of markup.
 *
 * Deliberately narrow: a genuine 403 from the provider's own API — wrong scope,
 * revoked token — is JSON and passes straight through.
 */
function blockNotice(upstream: Response, target: URL): Response | undefined {
  const type = upstream.headers.get("content-type") ?? "";

  if (upstream.status !== 403 || !type.includes("text/html")) {
    return;
  }

  return Response.json(
    {
      error: "upstream_blocked",
      message: `${target.host} refused this request from the proxy — it answered with a bot-protection page rather than an API response. This is upstream of the SDK and cannot be fixed with headers; the request has to come from a runtime that host accepts.`,
    },
    { status: 502 }
  );
}

/**
 * Adds the client secret for providers whose token endpoint wants one.
 *
 * These are published desktop-client secrets — Google documents its own as
 * non-confidential, and PKCE is what actually protects the flow — but holding
 * them here means the page's JavaScript bundle ships no credential at all.
 */
async function withClientSecret(
  request: Request,
  target: URL,
  headers: Headers
): Promise<BodyInit> {
  const secret = secretFor(target);
  const contentType = headers.get("content-type") ?? "";

  if (!secret || !contentType.includes("application/x-www-form-urlencoded")) {
    return (await request.arrayBuffer()) as BodyInit;
  }

  const form = new URLSearchParams(await request.text());

  if (!form.has("client_secret")) {
    form.set("client_secret", secret);
  }

  const encoded = form.toString();
  headers.set(
    "content-length",
    String(new TextEncoder().encode(encoded).byteLength)
  );

  return encoded;
}

function secretFor(target: URL): string | undefined {
  if (target.host.endsWith("googleapis.com")) {
    return process.env.GEMINI_CLIENT_SECRET ?? publicClientSecrets.gemini;
  }
}

/**
 * Sent in place of the reader's browser UA.
 *
 * Anthropic's token endpoint refuses a well-formed authorization-code exchange
 * that carries a browser-like `User-Agent`, and dresses the refusal as
 * `429 rate_limit_error` — which reads as throttling and is not. Measured
 * through this proxy, same route and body seconds apart, only the UA differing:
 * a Chrome UA answers 429 with no `request-id` and no `anthropic-ratelimit-*`
 * headers (a Cloudflare edge block), while `axios/1.13.1` reaches real grant
 * validation and answers `400 invalid_grant`.
 *
 * The strip list below already removed every other "a browser sent this"
 * signal — `origin`, `referer`, `sec-fetch-*`, `sec-ch-ua*` — and left the
 * loudest one in place. Setting a value rather than only deleting it keeps this
 * off whatever default the runtime would otherwise supply.
 */
const PROXY_USER_AGENT =
  "ai-oauth-sdk-playground/1.0 (+https://ai-oauth.themonk.dev)";

const STRIPPED_REQUEST_HEADERS = [
  "origin",
  "referer",
  "cookie",
  "host",
  /*
   * Replaced, not merely dropped — see PROXY_USER_AGENT. Deleting it alone
   * would leave the runtime's own default, which is not something this file
   * should be at the mercy of.
   */
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
  /*
   * The runtime negotiates its own encoding and decodes the result before we
   * see it. Forwarding the page's preference makes the two disagree, and the
   * body arrives as bytes nothing can read.
   */
  "accept-encoding",
];

/**
 * Sent on every response this proxy produces, whatever the upstream asked for.
 *
 * Each response here is the answer to exactly one caller's credentialed
 * request, and none of it is shared. Vercel's Edge Network keys a cached
 * function response on URL and method alone — no notion of who asked — so an
 * upstream's `cache-control: public, max-age=300` forwarded verbatim is enough
 * to have one reader's `/api/upstream/openrouter/models` served to every other
 * reader for the next five minutes, without a token of their own and without
 * the bot gate running at all. The strip list below already removes
 * `set-cookie`, which is the one header that would otherwise have suppressed
 * that.
 *
 * `no-store` rather than `no-cache`: the latter permits storing and only
 * requires revalidation, and a revalidation carries the *second* reader's
 * (absent) credentials. `private` in front of it is redundant per RFC 9111 —
 * nothing may be stored, so there is no store to scope — but it is the older
 * and more widely implemented of the two directives, and an intermediary that
 * understands only one of them should understand this one.
 *
 * **No `Vary` is set, deliberately.** `Vary` describes how to key an entry a
 * cache is allowed to hold; `no-store` says there is no entry. Adding
 * `Vary: Authorization` would only matter to a cache that stored the response
 * in defiance of `no-store`, which is not a cache that can be reasoned about —
 * and it would state the opposite of what this file means, implying these
 * responses are cacheable when correctly keyed. They are not: the proxy also
 * carries credentials that are not in `Authorization` at all (a token exchange
 * puts them in the form body), so a header-keyed cache entry would be wrong
 * even where it was honoured.
 */
const PRIVATE_CACHE_CONTROL = "private, no-store";

/*
 * `content-encoding` and `content-length` describe the body as it arrived on
 * the wire, and `upstream.body` has already been decoded by the time it reaches
 * us. Passing them on tells the browser to decompress plaintext, which fails —
 * a JSON error surfaces as binary garbage, and an SSE stream never parses.
 *
 * The cache directives below are removed rather than left to be overridden.
 * `cache-control` is rewritten anyway, but Vercel's CDN reads
 * `vercel-cdn-cache-control` and then `cdn-cache-control` *in preference to*
 * it, and Fastly reads `surrogate-control` the same way — so an upstream that
 * sent one of those would keep its own caching policy through a rewrite that
 * only touched `cache-control`. `expires`, `pragma` and `age` cannot outrank
 * `no-store`, and go for coherence rather than for safety: a response that
 * says it must not be stored should not also carry an age and an expiry.
 */
const STRIPPED_RESPONSE_HEADERS = [
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
