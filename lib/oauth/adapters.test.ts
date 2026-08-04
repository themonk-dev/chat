import type { TokenSet } from "@ai-oauth-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CodexOptions = {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

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

    /**
     * Drives the `fetch` wrapper `modelFor` hands `createOpenAI` — the one
     * place the outgoing Codex request is actually assembled — and returns
     * what went out. The global is stubbed before `modelFor` runs because
     * `withSseTailFlush()` captures the global as its inner `fetch` at
     * construction time, not per call.
     */
    async function codexRequest(
      sent: Record<string, unknown>,
      path = "/api/upstream/openai/responses"
    ): Promise<{
      body: Record<string, unknown>;
      url: string;
    }> {
      const inner = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolve(
              new Response("{}", {
                headers: { "content-type": "application/json" },
              })
            );
          })
      );

      vi.stubGlobal("fetch", inner);

      try {
        getTokensMock.mockResolvedValue({
          accessToken: "codex-tok",
          accountId: "acct-123",
          provider: "openai",
          raw: {},
          tokenType: "bearer",
        });

        await modelFor("openai", "gpt-5.5", "codex-tok");

        const codexFetch = createOpenAIMock.mock.calls.at(0)?.[0].fetch;

        expect(codexFetch).toBeTypeOf("function");

        await codexFetch?.(path, {
          body: JSON.stringify(sent),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        const [url, init] = inner.mock.calls.at(0) as unknown as [
          string,
          RequestInit,
        ];

        return {
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          url,
        };
      } finally {
        vi.unstubAllGlobals();
      }
    }

    /**
     * The regression: a `session_id` was added to the Responses body, and
     * Codex answers `{"detail":"Unsupported parameter: session_id"}` to every
     * request carrying one — so no message could be sent at all.
     *
     * It was never in the working predecessor
     * (`apps/demo/app/components/demo/transport.ts`, which sends only
     * `model`/`stream`/`input` and lets the descriptor supply the rest), and
     * it is in no descriptor either: `@ai-oauth-sdk/core` contains no
     * `session_id` anywhere. Codex CLI does send one, but as an HTTP *header*
     * for cache routing — never as a body parameter. If it is ever wanted it
     * belongs in the SDK descriptor's `apiHeaders`, alongside `originator`
     * and `OpenAI-Beta`, not hand-added to the body here.
     */
    it("sends no session_id in the Codex Responses body", async () => {
      const { body } = await codexRequest({
        input: [{ content: "hi", role: "user" }],
        model: "gpt-5.5",
        stream: true,
      });

      expect(body).not.toHaveProperty("session_id");
    });

    /**
     * The other half of the same assertion: dropping `session_id` must not
     * take the four things Codex genuinely does require with it. A body
     * missing these gets a 200 with an empty stream rather than an error,
     * which is far worse to debug than the 400 above.
     */
    it("still normalizes the Codex Responses body the way the backend needs", async () => {
      const { body, url } = await codexRequest({
        input: [{ content: "hi", id: "msg_server_side", role: "user" }],
        max_output_tokens: 100,
        model: "gpt-5.5",
        stream: true,
      });

      expect(body.store).toBe(false);
      expect(body.include).toContain("reasoning.encrypted_content");
      expect(body.reasoning).toMatchObject({
        effort: "medium",
        summary: "auto",
      });
      // Stateless backend: an input item may carry no server-side id.
      expect(body.input).toEqual([{ content: "hi", role: "user" }]);
      expect(body).not.toHaveProperty("max_output_tokens");
      // The model list the account can see is gated on this.
      expect(url).toContain("client_version=");
    });

    it("leaves a non-Responses request body alone", async () => {
      // The descriptor's own transform is path-guarded; reading it off the
      // descriptor rather than re-deriving it keeps that guard.
      const { body } = await codexRequest(
        { model: "gpt-5.5" },
        "/api/upstream/openai/models"
      );

      expect(body).toEqual({ model: "gpt-5.5" });
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
