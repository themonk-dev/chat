import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Codex path delegates to the SDK's own `fetchCodexModels` helper and
 * `clientFor`, rather than the generic bearer-token fetch every other
 * provider uses — both are mocked so that path is testable without a real
 * `AuthClient`/session storage.
 */
const mockFetchCodexModels = vi.fn();
// Partial: the real descriptors are still needed, because `models.ts` reads
// Claude's listing headers and Copilot's credential exchange off them rather
// than hand-copying either.
vi.mock("@ai-oauth-sdk/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ai-oauth-sdk/browser")>()),
  fetchCodexModels: (...args: unknown[]) => mockFetchCodexModels(...args),
}));

const mockClientFor = vi.fn();
vi.mock("@/lib/oauth/storage", () => ({
  clientFor: (id: string) => mockClientFor(id),
}));

import { defaultModelFor, fetchModelsFor, modelsFor } from "./models";
import { proxiedProviders } from "./providers";

describe("modelsFor / defaultModelFor", () => {
  it("returns the static catalogue for a known provider", () => {
    expect(modelsFor("claude")).toEqual([
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ]);
  });

  it("returns an empty list for an unknown provider", () => {
    expect(modelsFor("not-a-provider")).toEqual([]);
  });

  it("defaults to the first entry in the static catalogue", () => {
    expect(defaultModelFor("claude")).toBe("claude-sonnet-4-5");
    expect(defaultModelFor("qwen")).toBe("qwen3-coder-plus");
  });

  it("returns an empty string default for an unknown provider", () => {
    expect(defaultModelFor("not-a-provider")).toBe("");
  });
});

describe("fetchModelsFor", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the static list without fetching when there is no token", async () => {
    const models = await fetchModelsFor("openrouter", undefined);
    expect(models).toEqual(modelsFor("openrouter"));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * Gemini is the one provider this app never attempts to fetch — its
   * Code Assist API has no listing endpoint an OAuth token can reach (see
   * the comment on `MODELS` in `./models.ts`). Every other provider,
   * including Claude and Codex, is fetchable.
   */
  it("returns the static list without fetching for gemini", async () => {
    const models = await fetchModelsFor("gemini", "some-token");
    expect(models).toEqual(modelsFor("gemini"));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends exactly the token it was given, for the requested provider's route", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });

    await fetchModelsFor("xai", "xai-token-123");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("/api/upstream/xai/models");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer xai-token-123"
    );
  });

  it("parses a { data: [...] } body and prefers a provided name", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: [{ id: "grok-5", name: "Grok 5" }],
        }),
      ok: true,
    });

    const models = await fetchModelsFor("xai", "token");
    expect(models).toEqual([{ id: "grok-5", name: "Grok 5" }]);
  });

  it("humanizes an id when the listing omits a name", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [{ id: "grok-code-fast-1" }] }),
      ok: true,
    });

    const models = await fetchModelsFor("xai", "token");
    expect(models).toEqual([
      { id: "grok-code-fast-1", name: "Grok Code Fast 1" },
    ]);
  });

  it("sorts a fetched list by name", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: [
            { id: "z-model", name: "Zeta Model" },
            { id: "a-model", name: "Alpha Model" },
          ],
        }),
      ok: true,
    });

    const models = await fetchModelsFor("xai", "token");
    expect(models).toEqual([
      { id: "a-model", name: "Alpha Model" },
      { id: "z-model", name: "Zeta Model" },
    ]);
  });

  it("falls back to the static list on a non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({}),
      ok: false,
    });

    const models = await fetchModelsFor("openrouter", "token");
    expect(models).toEqual(modelsFor("openrouter"));
  });

  it("falls back to the static list when the request throws", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down")
    );

    const models = await fetchModelsFor("openrouter", "token");
    expect(models).toEqual(modelsFor("openrouter"));
  });

  it("falls back to the static list when the parsed body has no models", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });

    const models = await fetchModelsFor("qwen", "token");
    expect(models).toEqual(modelsFor("qwen"));
  });
});

/**
 * Copilot's `/models` sits behind the same gate as its chat/completions: it
 * wants the short-lived credential the `ghu_` GitHub token is exchanged for,
 * not the `ghu_` token itself. Sending the raw one 401s, and `fetchModelsFor`
 * swallows a 401 like any other failure — so the picker showed the two-entry
 * static fallback forever while sending worked fine against models the user
 * could not select. Nothing surfaced the failure, which is why these are
 * assertions on the *token sent* rather than on the returned list.
 */
describe("fetchModelsFor: github-copilot", () => {
  const originalFetch = global.fetch;
  const originalExchange =
    proxiedProviders["github-copilot"].exchangeCredential;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    proxiedProviders["github-copilot"].exchangeCredential = originalExchange;
  });

  function headersSent(): Record<string, string> {
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

    return init?.headers as Record<string, string>;
  }

  it("sends the exchanged credential, never the raw ghu_ token", async () => {
    proxiedProviders["github-copilot"].exchangeCredential = vi.fn(() =>
      Promise.resolve({
        accessToken: "copilot-short-lived",
        expiresAt: Date.now() + 10 * 60_000,
        headers: { "Copilot-Integration-Id": "vscode-chat" },
      })
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [{ id: "gpt-4.1" }] }),
      ok: true,
    });

    const models = await fetchModelsFor("github-copilot", "ghu_listing_token");

    const headers = headersSent();
    expect(headers.authorization).toBe("Bearer copilot-short-lived");
    expect(headers.authorization).not.toContain("ghu_listing_token");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(models).toEqual([{ id: "gpt-4.1", name: "Gpt 4.1" }]);
  });

  it("falls back to the static list when the exchange itself fails", async () => {
    proxiedProviders["github-copilot"].exchangeCredential = vi.fn(() =>
      Promise.reject(new Error("Copilot token exchange failed (HTTP 403)"))
    );

    const models = await fetchModelsFor("github-copilot", "ghu_no_sub");

    expect(models).toEqual(modelsFor("github-copilot"));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("fetchModelsFor: claude", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the anthropic version/beta headers alongside the bearer token", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });

    await fetchModelsFor("claude", "claude-token");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("/api/upstream/claude/models");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer claude-token");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  /**
   * Anthropic returns its listing newest-first, a better default than
   * alphabetical for a fast-moving catalogue. Alphabetically "Claude Haiku
   * 4.5" sorts before "Claude Opus 4.5" — proof this test would catch
   * Claude's list being run through the same sort as every other provider.
   */
  it("uses the fetched list in the order the API returned it, unsorted", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: [
            { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
            { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
          ],
        }),
      ok: true,
    });

    const models = await fetchModelsFor("claude", "claude-token");

    expect(models).toEqual([
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ]);
  });

  it("falls back to the static list on a non-ok response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({}),
      ok: false,
    });

    const models = await fetchModelsFor("claude", "claude-token");
    expect(models).toEqual(modelsFor("claude"));
  });
});

describe("fetchModelsFor: openai (Codex)", () => {
  beforeEach(() => {
    mockFetchCodexModels.mockReset();
    mockClientFor.mockReset();
    mockClientFor.mockReturnValue({ id: "fake-openai-client" });
  });

  it("returns the static list without calling the SDK helper when there is no token", async () => {
    const models = await fetchModelsFor("openai", undefined);
    expect(models).toEqual(modelsFor("openai"));
    expect(mockFetchCodexModels).not.toHaveBeenCalled();
  });

  it("uses the fetched slugs, humanized, when the SDK helper answers", async () => {
    mockFetchCodexModels.mockResolvedValue(["gpt-5-codex", "gpt-5"]);

    const models = await fetchModelsFor("openai", "chatgpt-token");

    expect(models).toEqual([
      { id: "gpt-5-codex", name: "Gpt 5 Codex" },
      { id: "gpt-5", name: "Gpt 5" },
    ]);
  });

  /**
   * The token used to authenticate this request always comes from
   * `clientFor("openai")` — the same memoized client the device flow in
   * `hooks/use-provider-auth.tsx` drives — never from a token string that
   * could belong to whichever provider happened to be active a moment ago.
   */
  it("looks up the client for openai specifically, not whatever was passed in", async () => {
    mockFetchCodexModels.mockResolvedValue(["gpt-5"]);

    await fetchModelsFor("openai", "chatgpt-token");

    expect(mockClientFor).toHaveBeenCalledWith("openai");
    expect(mockFetchCodexModels).toHaveBeenCalledWith({
      id: "fake-openai-client",
    });
  });

  it("falls back to the static list when the SDK helper throws", async () => {
    mockFetchCodexModels.mockRejectedValue(new Error("token_request_failed"));

    const models = await fetchModelsFor("openai", "chatgpt-token");
    expect(models).toEqual(modelsFor("openai"));
  });

  it("falls back to the static list when the SDK helper returns no slugs", async () => {
    mockFetchCodexModels.mockResolvedValue([]);

    const models = await fetchModelsFor("openai", "chatgpt-token");
    expect(models).toEqual(modelsFor("openai"));
  });
});
