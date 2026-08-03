import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelFor, fetchModelsFor, modelsFor } from "./models";

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

  it("returns the static list without fetching for a non-fetchable provider", async () => {
    const models = await fetchModelsFor("claude", "some-token");
    expect(models).toEqual(modelsFor("claude"));
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

  it("adds Copilot's required headers alongside the bearer token", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: [] }),
      ok: true,
    });

    await fetchModelsFor("github-copilot", "gh-token");

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gh-token");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
  });
});
