import { publicClientSecrets } from "@ai-oauth-sdk/core";
import {
  PRIVATE_CACHE_CONTROL,
  PROXY_USER_AGENT,
  STRIPPED_REQUEST_HEADERS,
  STRIPPED_RESPONSE_HEADERS,
} from "./proxy-headers";

/**
 * Mutates rather than rebuilds: the body may be a live upstream stream, and
 * copying it would mean reading it.
 */
export function uncacheable(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

  return response;
}

/**
 * Some providers refuse a proxy with an HTML challenge page, which lands in the
 * thread as a wall of markup. A genuine API 403 is JSON and passes through.
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

function secretFor(target: URL): string | undefined {
  if (target.host.endsWith("googleapis.com")) {
    return publicClientSecrets.gemini;
  }
}

/**
 * Published desktop-client secrets — PKCE is what protects the flow — held here
 * so the page's bundle ships no credential at all.
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

function forwardedRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);

  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }

  headers.set("user-agent", PROXY_USER_AGENT);

  return headers;
}

function forwardedResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);

  for (const name of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(name);
  }

  return headers;
}

/**
 * Rebuilds the request against the resolved upstream URL. The `Authorization`
 * header is forwarded untouched and never read — that is the point of this
 * file — and the body is streamed back rather than buffered.
 */
export async function forward(
  request: Request,
  target: URL
): Promise<Response> {
  const headers = forwardedRequestHeaders(request);
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

  return uncacheable(
    blockNotice(upstream, target) ??
      new Response(upstream.body, {
        headers: forwardedResponseHeaders(upstream),
        status: upstream.status,
        statusText: upstream.statusText,
      })
  );
}
