import type { TokenSet } from "@ai-oauth-sdk/browser";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/oauth/storage";
import { ProviderAuthProvider, useProviderAuth } from "./use-provider-auth";

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

const geminiToken: TokenSet = {
  accessToken: "gemini-access-token",
  provider: "gemini",
  raw: {},
  tokenType: "Bearer",
};

/**
 * What the SDK's `login()` does with a receiver, reduced to the two facts
 * this file is about: which receiver it was handed, and what redirect URI
 * that receiver resolved — the value the SDK sends as `redirect_uri` when it
 * builds the authorization URL, and the whole point of the change.
 */
function recordingClient(record: {
  receiverId?: string;
  redirectUri?: string;
}) {
  return {
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockImplementation(async (options) => {
      record.receiverId = options.receiver.id;

      const started = await options.receiver.start({
        provider: { id: "gemini" },
        signal: options.signal,
      });

      record.redirectUri = started.redirectUri;

      await started.close();

      return geminiToken;
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Gemini on a loopback origin, which is where this test runs: jsdom serves
 * these files from `http://localhost:3000`.
 *
 * Gemini's descriptor declares `loopbackPort: 0` — "any free port" — and
 * loopback redirects are accepted on arbitrary ports, so a page served from
 * a loopback address can hand Google its own `/callback` and be a legitimate
 * loopback redirect target. Probed against Google's real authorization
 * endpoint with the published gemini-cli client id: `http://localhost:PORT/
 * callback`, `http://127.0.0.1:PORT/callback` and `http://[::1]:PORT/callback`
 * all reach the account chooser, while `https://chat.themonk.dev/callback`
 * comes back `redirect_uri_mismatch` — which is what the sibling
 * `gemini-remote` file pins.
 */
describe("connecting Gemini from a loopback origin", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(clientFor).mockReset();
  });

  it("signs in through the popup receiver, redirecting to this origin's /callback", async () => {
    const record: { receiverId?: string; redirectUri?: string } = {};
    const gemini = recordingClient(record);

    vi.mocked(clientFor).mockImplementation(
      (id: string) =>
        (id === "gemini"
          ? gemini
          : {
              deviceLogin: vi.fn(),
              getTokens: vi.fn().mockResolvedValue(undefined),
              login: vi.fn(),
              logout: vi.fn().mockResolvedValue(undefined),
            }) as never
    );

    const { result } = renderHook(() => useProviderAuth(), {
      wrapper: ProviderAuthProvider,
    });

    act(() => {
      result.current.setActiveId("gemini");
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(record.receiverId).toBe("popup");
    expect(record.redirectUri).toBe(`${window.location.origin}/callback`);

    // Nothing parked for a reader to paste: the popup completes on its own.
    expect(result.current.pending).toBeUndefined();
    expect(result.current.tokens).toEqual(geminiToken);
    expect(result.current.isConnected).toBe(true);
  });
});
