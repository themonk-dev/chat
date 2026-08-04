/**
 * The deployed origin: on loopback, Gemini has no paste attempt to have bugs
 * in — it completes in a popup instead (see `flowFor`). This whole file is
 * about the lifetime of one paste attempt, so it belongs on the origin where
 * that attempt exists.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://chat.themonk.dev/" }
 */

import type { TokenSet } from "@ai-oauth-sdk/browser";
import {
  createBrowserAuthClient,
  publicClientIds,
} from "@ai-oauth-sdk/browser";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxiedProviders } from "@/lib/oauth/providers";
import { clientFor } from "@/lib/oauth/storage";
import { ProviderAuthProvider, useProviderAuth } from "./use-provider-auth";

/**
 * These tests drive the **real** `AuthClient` against Gemini's real
 * descriptor, not a fake `login`.
 *
 * That is the point of the file. The bug this task chased was reported as
 * "repeated clicks replay an authorization code, and the provider answers
 * 429" — a claim about what the SDK does with a second `login()` and what
 * reaches the token endpoint. A fake `login` cannot answer either question:
 * it does not mint `state`, does not derive a PKCE verifier, does not run
 * the state comparison, and never posts anything. So the client here is the
 * genuine one, `sessionStorage` is the genuine `AuthorizationRegistry`
 * backing store, and `fetch` is stubbed at the very edge so every token
 * request the flow really makes is counted.
 *
 * What that setup established, and what these tests now pin:
 *
 *   - a second `connect()` used to mint a *second* authorization — a fresh
 *     `state` and a fresh `code_verifier` — and leave the first `login()`
 *     in flight with its `pending:<state>` record stranded in storage;
 *   - the reader's code then failed the SDK's `state` comparison **before
 *     any token request was made at all**, so the replay theory cannot be
 *     what earns a 429: the provider never saw those attempts.
 */

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

/** A stand-in for the tab `window.open` hands back. */
type FakeTab = {
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
  focus: ReturnType<typeof vi.fn>;
};

type OpenedTab = { name: string; tab: FakeTab; url: string };

const originalOpen = window.open;
const originalFetch = globalThis.fetch;

function stubWindowOpen(): OpenedTab[] {
  const opened: OpenedTab[] = [];

  window.open = ((url: string, name?: string) => {
    const tab: FakeTab = { close: vi.fn(), closed: false, focus: vi.fn() };

    tab.close.mockImplementation(() => {
      tab.closed = true;
    });
    opened.push({ name: name ?? "", tab, url });

    return tab as unknown as Window;
  }) as typeof window.open;

  return opened;
}

/**
 * Every request that left for the token endpoint, and what the stub should
 * answer with next.
 *
 * `body` is kept so a test can prove what an exchange actually carried —
 * the literal claim "codes are being replayed" — rather than inferring it.
 *
 * The stub has to be installed *before* the client is constructed:
 * `AuthClient` captures `options.fetch ?? globalThis.fetch` once, in its
 * constructor, so a stub installed later is never consulted and the SDK
 * calls the runtime's real `fetch` with a root-relative proxy path.
 */
const tokenCalls: { body: string; url: string }[] = [];
let tokenReply: () => Response = tokenResponse;

function stubFetch(): void {
  globalThis.fetch = vi.fn((input: unknown, init: unknown) => {
    tokenCalls.push({
      body: String((init as { body?: unknown } | undefined)?.body ?? ""),
      url: String(input),
    });

    return Promise.resolve(tokenReply());
  }) as unknown as typeof fetch;
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "gemini-access-token",
      expires_in: 3600,
      refresh_token: "gemini-refresh-token",
      token_type: "Bearer",
    }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );
}

function invalidGrantResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "invalid_grant",
      error_description: "The authorization code is invalid.",
    }),
    { headers: { "content-type": "application/json" }, status: 400 }
  );
}

function useRealGeminiClient(): void {
  const client = createBrowserAuthClient({
    clientId: (publicClientIds as Record<string, string>).gemini,
    provider: proxiedProviders.gemini,
  });

  // `openrouter` is the hook's initial `activeId`, so its client is read
  // once on mount before any test touches Gemini. Nothing here exercises it.
  const inert = {
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(clientFor).mockImplementation((id: string) =>
    id === "gemini" ? (client as never) : (inert as never)
  );
}

/** The `state` Gemini's authorization URL carries, as the reader's tab sees it. */
function stateOf(url: string): string {
  const value = new URL(url).searchParams.get("state");

  if (!value) {
    throw new Error(`no state in ${url}`);
  }

  return value;
}

/** Every distinct authorization the flow minted, in order. */
function mintedStates(opened: OpenedTab[]): string[] {
  return [...new Set(opened.map((entry) => stateOf(entry.url)))];
}

/**
 * What the reader pastes back, in the shape Gemini's flow actually produces:
 * the whole address bar of the `localhost` redirect that failed to load,
 * carrying `code` and `state` as query params. Gemini has no custom
 * `parseCallback`, so this is read by the SDK's standard parser, the same
 * one a full redirect URL from any other provider would be.
 */
function pastedRedirect(code: string, state: string): string {
  return `http://localhost:1455/oauth2callback?code=${code}&state=${state}`;
}

function pendingRecordKeys(): string[] {
  return Object.keys(sessionStorage).filter((key) =>
    key.startsWith("pending:")
  );
}

function renderAuth() {
  const rendered = renderHook(() => useProviderAuth(), {
    wrapper: ProviderAuthProvider,
  });

  act(() => {
    rendered.result.current.setActiveId("gemini");
  });

  return rendered;
}

describe("the paste flow's live attempt", () => {
  beforeEach(() => {
    sessionStorage.clear();
    tokenCalls.length = 0;
    tokenReply = tokenResponse;
    vi.mocked(clientFor).mockReset();
    stubFetch();
    useRealGeminiClient();
  });

  afterEach(() => {
    window.open = originalOpen;
    globalThis.fetch = originalFetch;
  });

  /**
   * The mechanism the earlier review described, pinned so it cannot come
   * back: clicking "Open Gemini" a second time used to call
   * `client.login()` again, and `login()` calls `createAuthorization()`,
   * which mints a new `state` and a new PKCE verifier every single time.
   * The reader was then holding a tab whose code belonged to an
   * authorization the app had stopped listening to.
   *
   * A second click means "I lost that tab", not "start over": the reader
   * has usually already consented in the tab that is still open, and a
   * second authorization can only invalidate the code they are about to
   * paste. So the fix is not to abort-and-restart on every click — it is to
   * put the live attempt's tab back in front of them and mint nothing.
   */
  it("re-presents the tab it already opened instead of minting a second authorization", async () => {
    const opened = stubWindowOpen();
    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.connect();
    });

    expect(mintedStates(opened)).toHaveLength(1);
    // One authorization means one pending record. The stranded second one
    // was the visible trace of the orphaned attempt.
    expect(pendingRecordKeys()).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(opened[0].tab.focus).toHaveBeenCalled();
  });

  /**
   * The consequence that mattered to the reader. With two authorizations
   * live and the hook pointed at the second, the code from the tab actually
   * on screen — the first one — failed the SDK's `state` comparison, and
   * _that_ is why nothing ever connected. Note the second assertion: the
   * failure happened with **zero** token requests, which is what rules the
   * "replayed code earns a 429" theory out.
   */
  it("exchanges the code from the tab the reader is looking at, after a second Open", async () => {
    const opened = stubWindowOpen();
    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.connect();
    });

    const visible = stateOf(opened[0].url);

    await act(async () => {
      await result.current.submitCode(pastedRedirect("the-code", visible));
    });

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].url).toBe("/api/token/gemini");
    expect(new URLSearchParams(tokenCalls[0].body).get("code")).toBe(
      "the-code"
    );
    expect(result.current.isConnected).toBe(true);
    expect((result.current.tokens as TokenSet).accessToken).toBe(
      "gemini-access-token"
    );
  });

  /**
   * The stale callback tab, which the owner really does have open.
   *
   * Once an attempt has ended, the code sitting in the tab it opened is
   * spent — the registry consumed its `state`, and the provider will not
   * honour it twice. Pasting it into the *next* attempt has to say that, in
   * those words, rather than surfacing the SDK's CSRF wording or a raw
   * `HTTP 429` from an exchange that should never have been attempted.
   */
  it("refuses a code from a retired attempt with an explanation, and sends nothing", async () => {
    const opened = stubWindowOpen();

    tokenReply = invalidGrantResponse;

    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });

    const first = stateOf(opened[0].url);

    await act(async () => {
      await expect(
        result.current.submitCode(pastedRedirect("first-code", first))
      ).rejects.toThrow();
    });
    expect(tokenCalls).toHaveLength(1);

    // Retry: a genuinely fresh attempt, because the previous one is over.
    await act(async () => {
      await result.current.connect();
    });
    expect(mintedStates(opened)).toHaveLength(2);

    await act(async () => {
      await expect(
        result.current.submitCode(pastedRedirect("first-code", first))
      ).rejects.toThrow(/earlier/i);
    });

    // Nothing new left for the token endpoint — which is the whole point.
    expect(tokenCalls).toHaveLength(1);
  });

  /**
   * `pasteAttemptRef` used to survive its own attempt, so `submitCode`
   * handed the reader's second paste to a `resolveInput` that had already
   * settled — a no-op — and then awaited the same settled `completion`. The
   * reader saw the *first* paste's error again, with nothing sent and
   * nothing changed, for every subsequent click of Submit. Retry was the
   * only way out, and nothing said so.
   */
  it("does not replay a finished attempt's outcome on the next Submit", async () => {
    const opened = stubWindowOpen();

    tokenReply = invalidGrantResponse;

    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });

    const first = stateOf(opened[0].url);
    const failure = await act(() =>
      result.current
        .submitCode(pastedRedirect("first-code", first))
        .catch((error) => error)
    );

    expect(String(failure)).toMatch(/invalid|authorization code/i);

    // A different value, carrying no state of its own, so this can only be
    // answered by the attempt bookkeeping rather than by a state check.
    const second = await act(() =>
      result.current.submitCode("a-completely-different-code").catch((e) => e)
    );

    expect(String(second)).toMatch(/open the provider first/i);
  });

  /**
   * The tab the attempt opened is the attempt's to close. Leaving it behind
   * is what leaves a code on screen that nothing will accept any more —
   * the "stale callback tab" the owner keeps pasting from.
   */
  it("closes the tab it opened when the attempt is abandoned", async () => {
    const opened = stubWindowOpen();
    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });

    act(() => {
      result.current.cancel();
    });

    expect(opened[0].tab.close).toHaveBeenCalled();
  });
});

/**
 * The same-provider successive-attempt gap, which is the one place the two
 * existing guards both legitimately pass.
 *
 * `activeId` never moves — it is Gemini throughout — so an id comparison
 * sees agreement. The token's own `provider` tag says `gemini`, which is
 * true, so the tag pairing sees agreement too. Neither can tell that the
 * attempt which produced it was abandoned two attempts ago. Only the
 * attempt's own identity can, which is what the sequence guard adds.
 */
describe("a superseded attempt for the same provider", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(clientFor).mockReset();
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it("cannot write its token once a later attempt has started", async () => {
    stubWindowOpen();

    const geminiToken: TokenSet = {
      accessToken: "abandoned-gemini-token",
      provider: "gemini",
      raw: {},
      tokenType: "Bearer",
    };

    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let logins = 0;

    // A client that ignores its abort signal entirely, the way a real
    // exchange already on the wire does: the request completes, and the
    // token arrives long after the reader walked away from it.
    const geminiClient = {
      deviceLogin: vi.fn(),
      getTokens: vi.fn().mockResolvedValue(undefined),
      login: vi.fn().mockImplementation(async (options) => {
        logins += 1;

        const started = await options.receiver.start({
          openUrl: options.openUrl,
          provider: proxiedProviders.gemini,
          signal: options.signal,
        });

        await started.present(
          "https://accounts.google.com/o/oauth2/v2/auth?state=s1"
        );

        if (logins === 1) {
          await firstDone;

          return geminiToken;
        }

        return new Promise(() => undefined);
      }),
      logout: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(clientFor).mockImplementation(() => geminiClient as never);

    const { result } = renderAuth();

    await act(async () => {
      await result.current.connect();
    });

    // The reader gives up on that tab and starts over.
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.tokens).toBeUndefined();
    expect(result.current.isConnected).toBe(false);
  });
});
