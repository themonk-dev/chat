import { afterEach, describe, expect, it, vi } from "vitest";
import { forward, uncacheable } from "./proxy";
import { PROXY_USER_AGENT } from "./proxy-headers";

/**
 * Claude's token endpoint refuses a well-formed authorization-code exchange
 * that arrives with a browser `User-Agent`, and dresses the refusal as
 * `429 rate_limit_error`. Measured through this proxy, same route and body
 * seconds apart, only the UA differing: Chrome answered 429, `axios/1.13.1`
 * answered `400 invalid_grant`. It cost three wrong diagnoses to find, so it is
 * pinned here rather than left to a comment.
 */
describe("proxy request headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const capture = () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
  };

  const sent = (fetchMock: ReturnType<typeof capture>): Headers =>
    (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;

  it("never forwards the reader's browser user-agent", async () => {
    const fetchMock = capture();

    await forward(
      new Request("https://example.test/api/token/claude", {
        body: "grant_type=authorization_code",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0",
        },
        method: "POST",
      }),
      new URL("https://platform.claude.com/v1/oauth/token")
    );

    expect(sent(fetchMock).get("user-agent")).not.toMatch(/Mozilla|Chrome/);
  });

  it("sends a stated user-agent rather than leaving the runtime's default", async () => {
    const fetchMock = capture();

    await forward(
      new Request("https://example.test/api/token/claude", {
        body: "grant_type=authorization_code",
        method: "POST",
      }),
      new URL("https://platform.claude.com/v1/oauth/token")
    );

    expect(sent(fetchMock).get("user-agent")).toBe(PROXY_USER_AGENT);
  });

  it("still drops the other browser signals it always dropped", async () => {
    const fetchMock = capture();

    await forward(
      new Request("https://example.test/api/token/claude", {
        body: "grant_type=authorization_code",
        headers: {
          origin: "https://chat.themonk.dev",
          referer: "https://chat.themonk.dev/",
          "sec-fetch-mode": "cors",
        },
        method: "POST",
      }),
      new URL("https://platform.claude.com/v1/oauth/token")
    );

    const headers = sent(fetchMock);

    expect(headers.get("origin")).toBeNull();
    expect(headers.get("referer")).toBeNull();
    expect(headers.get("sec-fetch-mode")).toBeNull();
  });

  it("leaves Authorization untouched — the whole point of the file", async () => {
    const fetchMock = capture();

    await forward(
      new Request("https://example.test/api/upstream/claude/v1/messages", {
        body: "{}",
        headers: { authorization: "Bearer sk-ant-oat-example" },
        method: "POST",
      }),
      new URL("https://api.anthropic.com/v1/messages")
    );

    expect(sent(fetchMock).get("authorization")).toBe(
      "Bearer sk-ant-oat-example"
    );
  });
});

/**
 * Every response leaving this proxy is the answer to one caller's credentialed
 * request, so none of it may be stored by a shared cache. Vercel's Edge Network
 * keys on URL and method alone: a `cache-control: public, max-age=300` forwarded
 * from an upstream turns `/api/upstream/openrouter/models` into one user's
 * response served to every other user, with no token of their own and without
 * the bot gate ever running.
 *
 * These assert the headers the proxy *emits*, whatever the upstream said —
 * the guarantee has to be a property of this file rather than of seven
 * vendors' politeness, since the same handler also serves `/api/userinfo/*`.
 */
describe("proxy response caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const proxied = (upstream: Response): Promise<Response> => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstream));

    return forward(
      new Request("https://example.test/api/upstream/openrouter/models"),
      new URL("https://openrouter.ai/api/v1/models")
    );
  };

  it("refuses to pass a cacheable upstream cache-control through", async () => {
    const response = await proxied(
      new Response("{}", {
        headers: {
          "cache-control":
            "public, max-age=300, stale-while-revalidate=3600, stale-if-error=3600",
        },
        status: 200,
      })
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("states no-store even when the upstream said nothing about caching", async () => {
    const response = await proxied(new Response("{}", { status: 200 }));

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("drops the headers a CDN reads in preference to cache-control", async () => {
    const response = await proxied(
      new Response("{}", {
        headers: {
          age: "42",
          "cdn-cache-control": "max-age=600",
          expires: "Wed, 21 Oct 2099 07:28:00 GMT",
          pragma: "public",
          "surrogate-control": "max-age=600",
          "vercel-cdn-cache-control": "max-age=600",
        },
        status: 200,
      })
    );

    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(response.headers.get("surrogate-control")).toBeNull();
    expect(response.headers.get("expires")).toBeNull();
    expect(response.headers.get("pragma")).toBeNull();
    expect(response.headers.get("age")).toBeNull();
  });

  it("says the same on an error, which a cache would otherwise poison others with", async () => {
    const response = await proxied(
      new Response('{"error":"invalid_token"}', {
        headers: { "cache-control": "public, max-age=60" },
        status: 401,
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says the same on the bot-block notice this file substitutes", async () => {
    const response = await proxied(
      new Response("<html>challenge</html>", {
        headers: {
          "cache-control": "public, max-age=60",
          "content-type": "text/html",
        },
        status: 403,
      })
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  /**
   * Chat responses are server-sent events. Reading the body to completion to
   * rewrite headers would hold the whole reply until the last token, so the
   * fix for the above must not reach for `await upstream.text()`.
   */
  it("still hands back a live body rather than buffering it", async () => {
    let push: (chunk: string) => void = () => {
      /* replaced by the stream's start */
    };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    });

    const pending = proxied(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      })
    );

    push("data: first\n\n");

    const response = await pending;
    const reader = response.body?.getReader();
    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toBe("data: first\n\n");
  });

  /**
   * The route handler answers a bot-gate refusal and an unknown route without
   * reaching `forward()`. The 403 is a per-caller verdict; the 404 is
   * cacheable by heuristic even carrying no cache directive of its own.
   */
  it("stamps the responses the route handler builds for itself", () => {
    const blocked = uncacheable(
      Response.json({ error: "blocked" }, { status: 403 })
    );

    expect(blocked.headers.get("cache-control")).toBe("private, no-store");
    expect(blocked.status).toBe(403);
  });
});
