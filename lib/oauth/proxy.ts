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
 */
export async function forward(
  request: Request,
  target: URL
): Promise<Response> {
  const headers = new Headers(request.headers);

  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }

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

  const blocked = blockNotice(upstream, target);

  if (blocked) {
    return blocked;
  }

  /*
   * `upstream.body` is handed back untouched rather than buffered. Every
   * provider answers a chat with server-sent events, and reading the body to
   * completion here would hold the whole reply until the last token before the
   * page saw the first.
   */
  return new Response(upstream.body, {
    headers: out,
    status: upstream.status,
    statusText: upstream.statusText,
  });
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

const STRIPPED_REQUEST_HEADERS = [
  "origin",
  "referer",
  "cookie",
  "host",
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

/*
 * `content-encoding` and `content-length` describe the body as it arrived on
 * the wire, and `upstream.body` has already been decoded by the time it reaches
 * us. Passing them on tells the browser to decompress plaintext, which fails —
 * a JSON error surfaces as binary garbage, and an SSE stream never parses.
 */
const STRIPPED_RESPONSE_HEADERS = [
  "set-cookie",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
  "content-length",
];
