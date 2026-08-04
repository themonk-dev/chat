/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://chat.themonk.dev/" }
 */

import type { TokenSet } from "@ai-oauth-sdk/browser";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxiedProviders } from "@/lib/oauth/providers";
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
 * The production origin, which is the point of this file: the docblock above
 * moves jsdom off `localhost`, and nothing else here differs from its
 * loopback sibling.
 *
 * Google will not redirect a Desktop-app client to an HTTPS origin — probed
 * live, `https://chat.themonk.dev/callback` is answered `redirect_uri_mismatch`
 * before the account chooser is ever shown — and a loopback redirect cannot
 * reach a remote origin either. So the popup that works in development must
 * not follow the deployment, and the paste flow the site ships today has to
 * stay exactly as it is.
 */
describe("connecting Gemini from a non-loopback origin", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(clientFor).mockReset();
  });

  it("falls back to the paste flow rather than a popup Google would reject", async () => {
    let receiverId: string | undefined;

    const gemini = {
      deviceLogin: vi.fn(),
      getTokens: vi.fn().mockResolvedValue(undefined),
      login: vi.fn().mockImplementation(async (options) => {
        receiverId = options.receiver.id;

        const started = await options.receiver.start({
          openUrl: options.openUrl,
          provider: proxiedProviders.gemini,
          signal: options.signal,
        });

        await started.present(
          "https://accounts.google.com/o/oauth2/v2/auth?state=live-state"
        );
        await started.wait();

        return geminiToken;
      }),
      logout: vi.fn().mockResolvedValue(undefined),
    };

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

    expect(window.location.hostname).toBe("chat.themonk.dev");
    expect(receiverId).toBe("manual");
    expect(result.current.pending).toEqual({
      kind: "paste",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=live-state",
    });
  });
});
