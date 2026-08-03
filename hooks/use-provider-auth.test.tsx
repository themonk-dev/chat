import type { TokenSet } from "@ai-oauth-sdk/browser";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/oauth/storage";
import { ProviderAuthProvider, useProviderAuth } from "./use-provider-auth";

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

type FakeClient = {
  completeAuthorization: ReturnType<typeof vi.fn>;
  createAuthorization: ReturnType<typeof vi.fn>;
  deviceLogin: ReturnType<typeof vi.fn>;
  getTokens: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    completeAuthorization: vi.fn(),
    createAuthorization: vi.fn(),
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const grokToken: TokenSet = {
  accessToken: "grok-access-token",
  provider: "xai",
  raw: {},
  tokenType: "Bearer",
};

describe("useProviderAuth", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(clientFor).mockReset();
  });

  /**
   * Reproduces the round-2 bug end to end: the reader opens Connect on a
   * non-active device-flow provider (Grok), cancels — which restores
   * `activeId` the way `manage-providers.tsx`'s round-1 fix does — and only
   * then does the approval that was still in flight resolve. Before this
   * fix, `setTokens(result)` ran unconditionally and the composer would have
   * paired Grok's credential with whichever provider `activeId` had moved
   * on to. The client here ignores the abort signal entirely (real SDK
   * behavior may or may not stop in time), so this exercises the second,
   * independent guard — the `activeIdRef` check — not just the abort.
   */
  it("does not attach a device-flow token to a provider the reader switched to after cancelling", async () => {
    const grok = deferred<TokenSet>();
    let grokSignal: AbortSignal | undefined;

    const grokClient = makeClient({
      deviceLogin: vi.fn().mockImplementation((options) => {
        grokSignal = options.signal;
        options.onCode({
          userCode: "ABCD-1234",
          verificationUri: "https://x.ai/device",
        });
        return grok.promise;
      }),
    });
    const claudeClient = makeClient();
    const openrouterClient = makeClient();

    const clients: Record<string, FakeClient> = {
      claude: claudeClient,
      openrouter: openrouterClient,
      xai: grokClient,
    };
    vi.mocked(clientFor).mockImplementation(
      (id: string) => clients[id] as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    // Click Connect on Grok (not active): manage-providers.tsx's
    // handleConnect switches activeId before opening the dialog.
    act(() => {
      result.current.setActiveId("xai");
    });
    expect(result.current.activeId).toBe("xai");

    // The dialog's device-flow effect calls connect(), which starts the
    // device poll and parks the code in `pending`.
    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    expect(result.current.pending).toEqual({
      kind: "device",
      userCode: "ABCD-1234",
      verificationUri: "https://x.ai/device",
    });

    // Cancel: the reader backs out and manage-providers.tsx's round-1 fix
    // restores the provider they were on before (Claude).
    act(() => {
      result.current.setActiveId("claude");
    });
    expect(result.current.activeId).toBe("claude");
    expect(result.current.pending).toBeUndefined();
    // setActiveId aborts whatever connect() was still waiting on.
    expect(grokSignal?.aborted).toBe(true);

    // The reader approves the Grok device code anyway, in the still-open
    // verification tab, well after cancelling in this app.
    await act(async () => {
      grok.resolve(grokToken);
      await connectPromise;
    });

    // The credential must not have landed on Claude — or anywhere in
    // active state at all, since the flow it belonged to was abandoned.
    expect(result.current.activeId).toBe("claude");
    expect(result.current.tokens).toBeUndefined();
    expect(result.current.isConnected).toBe(false);
  });

  /**
   * The unremarkable case the fix must not break: connecting the provider
   * that is still active when the flow finishes writes its token normally.
   */
  it("still attaches a device-flow token when the provider stayed active throughout", async () => {
    const grok = deferred<TokenSet>();
    const grokClient = makeClient({
      deviceLogin: vi.fn().mockImplementation((options) => {
        options.onCode({
          userCode: "WXYZ-5678",
          verificationUri: "https://x.ai/device",
        });
        return grok.promise;
      }),
    });
    const openrouterClient = makeClient();

    const clients: Record<string, FakeClient> = {
      openrouter: openrouterClient,
      xai: grokClient,
    };
    vi.mocked(clientFor).mockImplementation(
      (id: string) => clients[id] as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    act(() => {
      result.current.setActiveId("xai");
    });

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });

    await act(async () => {
      grok.resolve(grokToken);
      await connectPromise;
    });

    expect(result.current.activeId).toBe("xai");
    expect(result.current.tokens).toEqual(grokToken);
    expect(result.current.isConnected).toBe(true);
  });
});
