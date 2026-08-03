import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelFor } from "@/lib/oauth/models";
import { nextSelection, useConnectedProviders } from "./use-active-chat";

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
   * The disconnect-recovery half of the same bug (finding 2): a provider
   * that was never touched by this transition (openrouter, connected from
   * earlier in the session) must not be wiped out just because a
   * different provider became active with no tokens of its own.
   */
  it("does not drop an unrelated already-connected provider while a new one activates", async () => {
    mockUseProviderAuth.mockReturnValue({
      activeId: "claude",
      tokens: undefined,
    });
    mockGetTokens.mockImplementation((id: string) =>
      Promise.resolve(
        id === "openrouter"
          ? { accessToken: "openrouter-secret", provider: "openrouter" }
          : undefined
      )
    );

    const { result } = renderHook(() => useConnectedProviders());

    await waitFor(() => {
      expect(result.current.get("openrouter")).toBe("openrouter-secret");
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
});
