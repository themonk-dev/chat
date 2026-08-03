import type { TokenSet } from "@ai-oauth-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CodexOptions = { headers?: Record<string, string> };

const createOpenAIMock = vi.fn((_options: CodexOptions) => ({
  responses: vi.fn(() => "codex-model"),
}));
const getTokensMock = vi.fn<() => Promise<TokenSet | undefined>>();

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (options: CodexOptions) => createOpenAIMock(options),
}));

vi.mock("./storage", () => ({
  clientFor: () => ({ getTokens: getTokensMock }),
}));

const { CLAUDE_SYSTEM, modelFor } = await import("./adapters");
const { proxiedProviders } = await import("./providers");

describe("CLAUDE_SYSTEM", () => {
  it("is the exact prompt Claude's OAuth-scoped Messages API requires", () => {
    // The Messages API checks this string, not merely its presence — copied
    // verbatim from the old playground's CLAUDE_SYSTEM constant. A refusal
    // ("only authorized for use with Claude Code") almost always means this
    // drifted.
    expect(CLAUDE_SYSTEM).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude."
    );
  });
});

describe("modelFor", () => {
  it("rejects a provider id none of the seven adapters handle", async () => {
    await expect(modelFor("not-a-provider", "model", "token")).rejects.toThrow(
      "No adapter yet for provider: not-a-provider"
    );
  });

  describe("openai (Codex)", () => {
    beforeEach(() => {
      createOpenAIMock.mockClear();
      getTokensMock.mockReset();
    });

    function headersSentToCreateOpenAI(): Record<string, string> {
      const call = createOpenAIMock.mock.calls.at(0);

      expect(call).toBeDefined();

      return call?.[0].headers ?? {};
    }

    it("includes chatgpt-account-id when storage has one for this token", async () => {
      getTokensMock.mockResolvedValue({
        accessToken: "codex-tok",
        accountId: "acct-123",
        provider: "openai",
        raw: {},
        tokenType: "bearer",
      });

      await modelFor("openai", "gpt-5-codex", "codex-tok");

      // This is the regression the fix targets: the account header used to
      // be silently dropped because modelFor only ever saw the bare access
      // token, never the stored record accountId lives on.
      expect(headersSentToCreateOpenAI()).toMatchObject({
        "chatgpt-account-id": "acct-123",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
      });
    });

    it("omits chatgpt-account-id when storage has no matching record", async () => {
      getTokensMock.mockResolvedValue(undefined);

      await modelFor("openai", "gpt-5-codex", "codex-tok");

      const headers = headersSentToCreateOpenAI();

      expect(headers).not.toHaveProperty("chatgpt-account-id");
      expect(headers).toMatchObject({
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
      });
    });

    it("does not attach a differently-tokened record's account id", async () => {
      // Storage has a real record, but for a different access token than
      // the one this call is actually using (e.g. a refresh mid-flight) —
      // attaching that account's id here would misattribute the request.
      getTokensMock.mockResolvedValue({
        accessToken: "some-other-token",
        accountId: "acct-999",
        provider: "openai",
        raw: {},
        tokenType: "bearer",
      });

      await modelFor("openai", "gpt-5-codex", "codex-tok");

      expect(headersSentToCreateOpenAI()).not.toHaveProperty(
        "chatgpt-account-id"
      );
    });
  });

  describe("github-copilot", () => {
    it("exchanges once per access token and caches the result", async () => {
      const exchangeCredential = vi.fn(async () => ({
        accessToken: "copilot-short-lived",
        expiresAt: Date.now() + 10 * 60_000,
        headers: { "Copilot-Integration-Id": "vscode-chat" },
      }));
      const original = proxiedProviders["github-copilot"].exchangeCredential;
      proxiedProviders["github-copilot"].exchangeCredential =
        exchangeCredential;

      try {
        await modelFor("github-copilot", "gpt-4", "ghu_cache_a");
        await modelFor("github-copilot", "gpt-4", "ghu_cache_a");

        expect(exchangeCredential).toHaveBeenCalledTimes(1);

        await modelFor("github-copilot", "gpt-4", "ghu_cache_b");

        expect(exchangeCredential).toHaveBeenCalledTimes(2);
      } finally {
        proxiedProviders["github-copilot"].exchangeCredential = original;
      }
    });

    it("re-exchanges once the cached credential is past its expiry", async () => {
      const exchangeCredential = vi
        .fn()
        .mockResolvedValueOnce({
          accessToken: "first",
          expiresAt: Date.now() - 1,
          headers: {},
        })
        .mockResolvedValueOnce({
          accessToken: "second",
          expiresAt: Date.now() + 10 * 60_000,
          headers: {},
        });
      const original = proxiedProviders["github-copilot"].exchangeCredential;
      proxiedProviders["github-copilot"].exchangeCredential =
        exchangeCredential;

      try {
        await modelFor("github-copilot", "gpt-4", "ghu_expiring");
        await modelFor("github-copilot", "gpt-4", "ghu_expiring");

        expect(exchangeCredential).toHaveBeenCalledTimes(2);
      } finally {
        proxiedProviders["github-copilot"].exchangeCredential = original;
      }
    });
  });
});
