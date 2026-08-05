import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelFor } from "@/lib/oauth/model-catalog";
import {
  nextSelection,
  preferredModel,
  resolveRequest,
} from "@/lib/oauth/selection";
import { useConnectedProviders } from "./use-connected-providers";

/**
 * `useConnectedProviders` depends on `useProviderAuth` (owned by another
 * in-flight task, not to be edited here) and `clientFor` (storage). Both are
 * mocked so the staleness window that produced the token-for-the-wrong-
 * provider bug can be reproduced deterministically, without a real
 * sessionStorage-backed OAuth client. `vi.mock` calls are hoisted above
 * every import by Vitest's transform regardless of where they appear in the
 * file, and are scoped to this file — each test file gets its own module
 * registry — so this cannot affect `hooks/use-active-chat.test.ts`'s
 * unrelated `shouldPersistChat` / `usePersistChat` coverage.
 */
const mockUseProviderAuth = vi.fn();
vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => mockUseProviderAuth(),
}));

const mockGetTokens = vi.fn();
vi.mock("@/lib/oauth/storage", () => ({
  clientFor: (id: string) => ({
    getTokens: () => mockGetTokens(id),
  }),
}));

describe("useConnectedProviders", () => {
  beforeEach(() => {
    mockUseProviderAuth.mockReset();
    mockGetTokens.mockReset();
    mockGetTokens.mockResolvedValue(undefined);
  });

  /**
   * Reproduces the exact staleness window: `setActiveId("claude")` has
   * already landed, but `useProviderAuth`'s own async refresh has not
   * resolved yet, so the `tokens` it hands back still describes the
   * previous active provider, openrouter. Asserted synchronously, before
   * any `await` lets a microtask run: the old code's mirror effect wrote
   * `connected.set(activeId, tokens.accessToken)` directly off the closure,
   * with no `await` in between, so the wrong value would already be visible
   * at this exact point — before the mount-time full poll (a separate,
   * async, always-present effect) gets a chance to self-correct it and mask
   * the bug.
   */
  it("never attributes a stale token to the newly active provider", () => {
    mockUseProviderAuth.mockReturnValue({
      activeId: "claude",
      tokens: { accessToken: "openrouter-secret", provider: "openrouter" },
    });

    const { result } = renderHook(() => useConnectedProviders());

    expect(result.current.get("claude")).not.toBe("openrouter-secret");
  });

  it("attributes a token to the provider that issued it once storage confirms it", async () => {
    mockUseProviderAuth.mockReturnValue({
      activeId: "claude",
      tokens: { accessToken: "claude-secret", provider: "claude" },
    });
    mockGetTokens.mockImplementation((id: string) =>
      Promise.resolve(
        id === "claude"
          ? { accessToken: "claude-secret", provider: "claude" }
          : undefined
      )
    );

    const { result } = renderHook(() => useConnectedProviders());

    await waitFor(() => {
      expect(result.current.get("claude")).toBe("claude-secret");
    });
  });

  /**
   * The half of the bug finding 2 was actually about: a provider becomes
   * active while `tokens` is still stale/undefined (describing whatever the
   * previous active provider's tokens looked like), and storage genuinely
   * does hold a token for the newly active one. Pre-fix, the mirror trusted
   * `tokens` at face value and deleted the newly active provider's entry —
   * even though it was already correctly connected — because "undefined"
   * looks identical to "not connected yet" whether or not that's true.
   *
   * The mount-time full poll is established *first* and its `waitFor`
   * settled before the stale transition is triggered, specifically so that
   * poll — a separate, always-correct, but mount-only effect — cannot mask
   * the mirror's mistake by re-running afterward and quietly fixing it. It
   * only ever runs once; by the time the stale commit lands, there is
   * nothing left to self-correct a wrong delete.
   */
  it("re-confirms a newly active provider's token instead of trusting stale tokens", async () => {
    mockUseProviderAuth.mockReturnValue({
      activeId: "openrouter",
      tokens: { accessToken: "openrouter-secret", provider: "openrouter" },
    });
    mockGetTokens.mockImplementation((id: string) =>
      Promise.resolve(
        id === "claude"
          ? { accessToken: "claude-secret", provider: "claude" }
          : id === "openrouter"
            ? { accessToken: "openrouter-secret", provider: "openrouter" }
            : undefined
      )
    );

    const { result, rerender } = renderHook(() => useConnectedProviders());

    // Baseline, from the mount-time poll alone: claude is already
    // connected, before the provider switch under test ever happens.
    await waitFor(() => {
      expect(result.current.get("claude")).toBe("claude-secret");
    });

    // The exact staleness commit: setActiveId("claude") has landed, but
    // useProviderAuth's own async refresh has not resolved yet.
    mockUseProviderAuth.mockReturnValue({
      activeId: "claude",
      tokens: undefined,
    });
    rerender();

    await waitFor(() => {
      expect(result.current.get("claude")).toBe("claude-secret");
    });
  });
});

describe("nextSelection", () => {
  it("keeps the current selection when its provider is still connected", () => {
    const connected = new Map([["claude", "t"]]);
    expect(
      nextSelection({
        connected,
        currentModelId: "claude-sonnet-4-5",
        owner: "claude",
      })
    ).toEqual({ kind: "keep" });
  });

  it("does nothing when nothing was ever selected and nothing is connected", () => {
    const connected = new Map<string, string>();
    expect(
      nextSelection({ connected, currentModelId: "", owner: undefined })
    ).toEqual({ kind: "keep" });
  });

  it("falls back to the first connected provider in PROVIDER_ORDER, not just any connected provider", () => {
    // qwen comes after openrouter in PROVIDER_ORDER; openrouter must win
    // even though it was inserted second.
    const connected = new Map([
      ["qwen", "t1"],
      ["openrouter", "t2"],
    ]);
    expect(
      nextSelection({ connected, currentModelId: "", owner: undefined })
    ).toEqual({
      kind: "set",
      modelId: defaultModelFor("openrouter"),
      providerId: "openrouter",
    });
  });

  it("recovers to another connected provider's default when the owner disconnects", () => {
    const connected = new Map([["claude", "t"]]);
    expect(
      nextSelection({
        connected,
        currentModelId: "grok-4",
        owner: "xai",
      })
    ).toEqual({
      kind: "set",
      modelId: defaultModelFor("claude"),
      providerId: "claude",
    });
  });

  it("clears the selection when its provider disconnects and nothing else is connected", () => {
    const connected = new Map<string, string>();
    expect(
      nextSelection({
        connected,
        currentModelId: "claude-sonnet-4-5",
        owner: "claude",
      })
    ).toEqual({ kind: "clear" });
  });

  it("puts a reader on ChatGPT when it is one of several connected", () => {
    const connected = new Map([
      ["qwen", "t1"],
      ["openai", "t2"],
      ["openrouter", "t3"],
    ]);
    expect(
      nextSelection({ connected, currentModelId: "", owner: undefined })
    ).toEqual({
      kind: "set",
      modelId: defaultModelFor("openai"),
      providerId: "openai",
    });
  });

  /**
   * The bug this pair exists for: only `activeId` survives a reload, so the
   * selection is re-seeded from the pinned catalogue. Anthropic answers
   * undated ids where the catalogue pins dated ones, so the seed names a model
   * the provider no longer offers — and used to stay there.
   */
  it("moves off a seeded model the provider's listing does not carry", () => {
    expect(
      nextSelection({
        connected: new Map([["claude", "t"]]),
        currentModelId: "claude-sonnet-4-5-20250929",
        listings: [
          {
            models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
            providerId: "claude",
          },
        ],
        owner: "claude",
      })
    ).toEqual({
      kind: "set",
      modelId: "claude-haiku-4-5",
      providerId: "claude",
    });
  });

  it("leaves a model the listing still carries alone, since it may be the reader's own pick", () => {
    expect(
      nextSelection({
        connected: new Map([["claude", "t"]]),
        currentModelId: "claude-opus-4-1",
        listings: [
          {
            models: [
              { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
              { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
            ],
            providerId: "claude",
          },
        ],
        owner: "claude",
      })
    ).toEqual({ kind: "keep" });
  });

  it("seeds a fresh connection from the listing rather than the catalogue", () => {
    expect(
      nextSelection({
        connected: new Map([["xai", "t"]]),
        currentModelId: "",
        listings: [
          {
            models: [{ id: "grok-5", name: "Grok 5" }],
            providerId: "xai",
          },
        ],
        owner: undefined,
      })
    ).toEqual({ kind: "set", modelId: "grok-5", providerId: "xai" });
  });
});

/**
 * Five of the six live listings come back sorted by name, so their first entry
 * is an alphabetical accident. The catalogue's first entry is not — it encodes
 * quota (Flash before Pro) and surface (Codex before GPT-5) — so it is only
 * given up when the provider stops offering it.
 */
describe("preferredModel", () => {
  it("keeps the catalogue default while the listing still offers it", () => {
    expect(
      preferredModel("openai", [
        { id: "gpt-5" },
        { id: defaultModelFor("openai") },
      ])
    ).toBe(defaultModelFor("openai"));
  });

  it("takes the listing's first entry once the default is gone", () => {
    expect(preferredModel("openai", [{ id: "gpt-6" }, { id: "gpt-5" }])).toBe(
      "gpt-6"
    );
  });

  it("falls back to the catalogue while no listing has arrived", () => {
    expect(preferredModel("openai", [])).toBe(defaultModelFor("openai"));
  });
});

describe("resolveRequest", () => {
  it("addresses the send to the model's owner and pays for it with that owner's token", () => {
    // The `"keep"` outcome above is exactly the state this arrives in: the
    // selection still belongs to openrouter while activeId has moved to xai.
    expect(
      resolveRequest({
        activeAccessToken: "xai-secret",
        activeId: "xai",
        connected: new Map([
          ["openrouter", "openrouter-secret"],
          ["xai", "xai-secret"],
        ]),
        modelId: "anthropic/claude-sonnet-4.5",
        owner: "openrouter",
      })
    ).toEqual({
      accessToken: "openrouter-secret",
      modelId: "anthropic/claude-sonnet-4.5",
      providerId: "openrouter",
    });
  });

  it("falls back to the active provider when nothing has been selected yet", () => {
    expect(
      resolveRequest({
        activeAccessToken: "claude-secret",
        activeId: "claude",
        connected: new Map<string, string>(),
        modelId: "",
        owner: undefined,
      })
    ).toEqual({
      accessToken: "claude-secret",
      modelId: "",
      providerId: "claude",
    });
  });

  it("never borrows the active provider's token for somebody else's model", () => {
    // The map has not caught up with a fresh connect for claude, so the only
    // token on hand belongs to openrouter. Fail closed rather than send
    // claude's model id with openrouter's bearer.
    expect(
      resolveRequest({
        activeAccessToken: "openrouter-secret",
        activeId: "openrouter",
        connected: new Map([["openrouter", "openrouter-secret"]]),
        modelId: "claude-sonnet-4-5",
        owner: "claude",
      })
    ).toEqual({
      accessToken: undefined,
      modelId: "claude-sonnet-4-5",
      providerId: "claude",
    });
  });
});
