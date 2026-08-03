import type { TokenSet } from "@ai-oauth-sdk/browser";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/oauth/storage";
import { ProviderAuthProvider, useProviderAuth } from "./use-provider-auth";

/** The subset of `CallbackReceiver`'s `StartedReceiver` this file drives. */
type FakeStartedReceiver = {
  close: () => Promise<void>;
  present: (url: string) => Promise<void>;
  wait: () => Promise<{ code: string; state?: string }>;
};
type FakeReceiver = {
  start: (context: {
    openUrl?: (url: string) => void | Promise<void>;
    provider: { id: string; redirect: { hostedUri: string } };
    signal?: AbortSignal;
  }) => Promise<FakeStartedReceiver>;
};

/**
 * Drives a real `CallbackReceiver` (in practice, the `manualReceiver({
 * prompt })` instance `connect()`'s paste branch actually constructs — this
 * file never mocks `@ai-oauth-sdk/browser`, so it is the genuine SDK code)
 * the same way `AuthClient.login()` does: `start()`, `present(url)`,
 * `wait()`, `close()`. Standing in for the parts of `login()` this suite
 * does not need to re-prove — PKCE, the token exchange itself — while still
 * exercising `manualReceiver`'s real `prompt`/parse handshake, including its
 * real redirect-URI resolution (`provider.redirect.hostedUri`, the same
 * field Claude's real descriptor sets, is what this task's "no redirect
 * URI" bug was missing).
 */
async function fakeLogin(
  options: { receiver: FakeReceiver } & Parameters<FakeReceiver["start"]>[0],
  providerId: string,
  token: TokenSet
): Promise<TokenSet> {
  const started = await options.receiver.start({
    openUrl: options.openUrl,
    provider: {
      id: providerId,
      redirect: { hostedUri: "https://example.com/oauth/callback" },
    },
    signal: options.signal,
  });
  try {
    await started.present("https://example.com/authorize?mock=1");
    await started.wait();
    return token;
  } finally {
    await started.close();
  }
}

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

type FakeClient = {
  completeAuthorization: ReturnType<typeof vi.fn>;
  createAuthorization: ReturnType<typeof vi.fn>;
  deviceLogin: ReturnType<typeof vi.fn>;
  getTokens: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    completeAuthorization: vi.fn(),
    createAuthorization: vi.fn(),
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * A client whose `login` and `getTokens` share one variable, the way a real
 * `AuthClient` shares `#cachedTokens` between `setTokens` (which `login`
 * calls on success) and `getTokens`. `makeClient`'s default `getTokens`
 * always resolves `undefined` regardless of what any other method did,
 * which is realistic for two independent fakes but not for what this test
 * needs to prove: that a write through `clientFor(id)` is visible to a
 * later read through the same call.
 */
function makeStatefulClient(token: TokenSet): FakeClient {
  let stored: TokenSet | undefined;

  return makeClient({
    getTokens: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    login: vi.fn().mockImplementation(() => {
      stored = token;
      return Promise.resolve(token);
    }),
  });
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
   * then does the approval that was still in flight resolve. Before the
   * round-2 fix, `setTokens(result)` ran unconditionally and the composer
   * would have paired Grok's credential with whichever provider `activeId`
   * had moved on to. The client here ignores the abort signal entirely
   * (real SDK behavior may or may not stop in time), so this exercises the
   * second, independent guard — `taggedTokens`' provider-tag pairing — not
   * just the abort.
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

  /**
   * The round-3 case: `activeId` never moves, so an id-based guard (compare
   * the attempt's captured id against `activeId` when the result lands)
   * would see "xai" both times and wave this through. The token itself
   * says otherwise — its own `provider` field, which the SDK sets and this
   * hook does not choose, disagrees with the attempt it came back from.
   * That mismatch, not a stale ref or a moved `activeId`, is what must stop
   * it from being exposed as Grok's credential.
   */
  it("does not attach a token whose own provider tag disagrees with the attempt, even when activeId never moved", async () => {
    const mistagged: TokenSet = { ...grokToken, provider: "openai" };
    const grokClient = makeClient({
      deviceLogin: vi.fn().mockImplementation((options) => {
        options.onCode({
          userCode: "MISM-ATCH",
          verificationUri: "https://x.ai/device",
        });
        return Promise.resolve(mistagged);
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

    await act(async () => {
      await result.current.connect();
    });

    // activeId is still "xai" throughout — an id-comparison guard alone
    // would not have caught this.
    expect(result.current.activeId).toBe("xai");
    expect(result.current.tokens).toBeUndefined();
    expect(result.current.isConnected).toBe(false);
  });

  /**
   * Guards against the cache-split bug a concurrent change surfaced: the
   * SDK's `loginWithPopup()` helper builds its own throwaway `AuthClient`
   * around the shared storage, so its `setTokens` (called internally on
   * success) never reaches the memoized client `clientFor(id)` hands out
   * everywhere else — that client's own `getTokens()` cache goes stale at
   * `undefined` forever, which is exactly what `manage-providers.tsx` and
   * the model list read. `connect()` must go through `clientFor(activeId)`
   * itself (via `client.login()`) rather than the helper, so a write and a
   * later read are the same call on the same instance — proven here with a
   * client that would fail this assertion if `getTokens` and `login` were
   * on two different objects, the way `loginWithPopup` would produce.
   */
  it("routes a popup connect through the memoized client, so a later getTokens() call sees it", async () => {
    const openrouterToken: TokenSet = {
      accessToken: "openrouter-access-token",
      provider: "openrouter",
      raw: {},
      tokenType: "Bearer",
    };
    const openrouterClient = makeStatefulClient(openrouterToken);

    const clients: Record<string, FakeClient> = {
      openrouter: openrouterClient,
    };
    vi.mocked(clientFor).mockImplementation(
      (id: string) => clients[id] as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    // openrouter is the default active provider, and the only popup-flow
    // one in the registry — no setActiveId needed.
    expect(result.current.activeId).toBe("openrouter");

    await act(async () => {
      await result.current.connect();
    });

    expect(openrouterClient.login).toHaveBeenCalledTimes(1);
    expect(result.current.tokens).toEqual(openrouterToken);
    expect(result.current.isConnected).toBe(true);

    // The invariant this guards: whatever else calls clientFor("openrouter")
    // after this — manage-providers.tsx's connection dot, the model list —
    // must see the same token, because it reads the same client instance
    // this hook just wrote through.
    await expect(clientFor("openrouter").getTokens()).resolves.toEqual(
      openrouterToken
    );
  });

  /**
   * The fix for the second regression this task surfaced: `connect()`'s
   * paste branch used to call a bare `createAuthorization()`, which throws
   * "No redirect URI for provider" for Claude and Gemini — both rely on a
   * receiver to supply one (Claude's `hostedUri`, Gemini's loopback). Paste
   * now goes through `client.login({ receiver: manualReceiver({ prompt })
   * })`, the same as popup goes through `client.login({ receiver:
   * popupReceiver() })` — this drives a real `manualReceiver` instance the
   * way `AuthClient.login()` would, and checks the whole handshake: `pending`
   * is parked at the URL `prompt` receives, `connect()` resolves once that
   * happens rather than waiting for the reader, and `submitCode` is what
   * actually unblocks the exchange and lands the token.
   */
  it("completes a paste connect through client.login(), matching Claude's real 'no redirect URI' failure mode fixed here", async () => {
    const claudeToken: TokenSet = {
      accessToken: "claude-access-token",
      provider: "claude",
      raw: {},
      tokenType: "Bearer",
    };
    const claudeClient = makeClient({
      login: vi
        .fn()
        .mockImplementation((options) =>
          fakeLogin(options, "claude", claudeToken)
        ),
    });
    const openrouterClient = makeClient();

    const clients: Record<string, FakeClient> = {
      claude: claudeClient,
      openrouter: openrouterClient,
    };
    vi.mocked(clientFor).mockImplementation(
      (id: string) => clients[id] as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    act(() => {
      result.current.setActiveId("claude");
    });

    // connect() resolves as soon as `prompt` is called — it does not wait
    // for the reader to paste anything back.
    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.pending).toEqual({
      kind: "paste",
      url: "https://example.com/authorize?mock=1",
    });
    expect(result.current.tokens).toBeUndefined();

    await act(async () => {
      await result.current.submitCode("code=abc123&state=xyz");
    });

    expect(result.current.pending).toBeUndefined();
    expect(result.current.tokens).toEqual(claudeToken);
    expect(result.current.isConnected).toBe(true);
  });

  /**
   * Paste gained the same background-continuation risk popup and device
   * already had once `connect()` started routing it through `client.login()`
   * — the receiver's `wait()` does not settle until `submitCode` is called,
   * so a reader who opens paste on a non-active provider and cancels leaves
   * that wait outstanding. Unlike device and popup, though, nothing external
   * can complete a paste flow later: only this hook's own `submitCode` can
   * ever settle it, and `setActiveId` (which every restore goes through)
   * clears `pasteAttemptRef` in the same call that aborts the signal. So the
   * guarantee here is stronger than "a late result cannot masquerade as the
   * new provider's" — there is no attempt left for a late `submitCode` call
   * to resolve into anything at all, and it says so rather than silently
   * succeeding.
   */
  it("aborts a cancelled paste attempt and refuses a submitCode call for it afterward", async () => {
    const claudeToken: TokenSet = {
      accessToken: "claude-access-token",
      provider: "claude",
      raw: {},
      tokenType: "Bearer",
    };
    let claudeSignal: AbortSignal | undefined;
    const claudeClient = makeClient({
      login: vi.fn().mockImplementation((options) => {
        claudeSignal = options.signal;
        return fakeLogin(options, "claude", claudeToken);
      }),
    });
    const openrouterClient = makeClient();

    const clients: Record<string, FakeClient> = {
      claude: claudeClient,
      openrouter: openrouterClient,
    };
    vi.mocked(clientFor).mockImplementation(
      (id: string) => clients[id] as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    act(() => {
      result.current.setActiveId("claude");
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.pending?.kind).toBe("paste");

    const staleSubmitCode = result.current.submitCode;

    // Cancel: back to openrouter, the way manage-providers.tsx's restore
    // does.
    act(() => {
      result.current.setActiveId("openrouter");
    });
    expect(result.current.activeId).toBe("openrouter");
    expect(result.current.pending).toBeUndefined();
    expect(claudeSignal?.aborted).toBe(true);

    // Nothing in the real UI can still call this — Claude's AuthDialog
    // unmounted the moment activeId changed — but if something did, it
    // must not silently pretend to succeed.
    await expect(staleSubmitCode("code=abc123&state=xyz")).rejects.toThrow(
      /open the provider first/i
    );

    expect(result.current.activeId).toBe("openrouter");
    expect(result.current.tokens).toBeUndefined();
    expect(result.current.isConnected).toBe(false);
  });
});
