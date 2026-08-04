import { afterEach, describe, expect, it, vi } from "vitest";
import { forward } from "./proxy";

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

    expect(sent(fetchMock).get("user-agent")).toContain("ai-oauth-sdk");
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
