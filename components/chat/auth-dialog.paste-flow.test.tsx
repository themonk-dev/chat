/**
 * Run at the deployed origin, not jsdom's default `localhost`.
 *
 * Gemini signs in by pasting only where a loopback redirect is unavailable —
 * on loopback it completes in a popup instead (see `flowFor`). jsdom serves
 * every test from `localhost` unless told otherwise, so a paste-flow test
 * left on the default origin is testing a flow that origin never runs. This
 * is the one docblock that puts the test on the origin its subject belongs
 * to.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://chat.themonk.dev/" }
 */

import type { TokenSet } from "@ai-oauth-sdk/browser";
import { OAuthError } from "@ai-oauth-sdk/browser";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderAuthProvider,
  useProviderAuth,
} from "@/hooks/use-provider-auth";
import { proxiedProviders } from "@/lib/oauth/providers";
import { clientFor } from "@/lib/oauth/storage";
import { AuthDialog } from "./auth-dialog";

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
  }),
}));

vi.mock("usehooks-ts", () => ({
  useCopyToClipboard: () => ["", () => Promise.resolve(true)],
}));

type FakeTab = { close: () => void; closed: boolean; focus: () => void };

const originalOpen = window.open;

function stubWindowOpen(): FakeTab[] {
  const tabs: FakeTab[] = [];

  window.open = (() => {
    const tab: FakeTab = {
      close: () => {
        tab.closed = true;
      },
      closed: false,
      focus: () => undefined,
    };

    tabs.push(tab);

    return tab as unknown as Window;
  }) as typeof window.open;

  return tabs;
}

/**
 * A paste-flow client that parks at `prompt` the way Gemini's really does,
 * and then answers the reader's pasted code with `reply`.
 */
function pasteClient(reply: () => Promise<TokenSet>) {
  return {
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockImplementation(async (options) => {
      const started = await options.receiver.start({
        openUrl: options.openUrl,
        // Gemini's real descriptor, so `manualReceiver` reads the pasted
        // redirect URL with the same parser the hook and the SDK use.
        provider: proxiedProviders.gemini,
        signal: options.signal,
      });

      await started.present(
        "https://accounts.google.com/o/oauth2/v2/auth?state=live-state"
      );
      await started.wait();

      return await reply();
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * `manage-providers.tsx` reduced to "open the dialog on Gemini".
 *
 * `onOpenChange` is a `useState` setter, exactly as both real call sites
 * pass one. It matters: `AuthDialog`'s mount effect lists `startDevice`
 * among its dependencies and clears `error` when it runs, and `startDevice`
 * closes over `onOpenChange` — so an inline arrow here would give the effect
 * a new identity on every context change and silently wipe the error this
 * test is about.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  const { setActiveId } = useProviderAuth();

  /**
   * Moves the provider *then* opens, which is the order both real call sites
   * use. Mounting it already open would leave the dialog on whichever provider
   * a first visit lands on — and if that one is a device provider, the mount
   * effect fires a device request this test never asked for.
   */
  const pickGemini = useCallback(() => {
    setActiveId("gemini");
    setOpen(true);
  }, [setActiveId]);

  return (
    <>
      <button onClick={pickGemini} type="button">
        pick gemini
      </button>
      <AuthDialog onOpenChange={setOpen} open={open} />
    </>
  );
}

function renderDialog() {
  render(
    <ProviderAuthProvider>
      <Harness />
    </ProviderAuthProvider>
  );

  act(() => {
    fireEvent.click(screen.getByText("pick gemini"));
  });
}

/** Lets every pending microtask and timer settle inside `act`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the paste dialog", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(clientFor).mockReset();
    stubWindowOpen();
  });

  afterEach(() => {
    cleanup();
    window.open = originalOpen;
  });

  /**
   * The reader has no way to tell, from the dialog, which tab the input
   * belongs to — and with a stale callback tab open from an earlier attempt
   * that is exactly the thing they get wrong. Once a tab is open the button
   * stops offering to open another (it no longer does) and says so, and the
   * input says which tab it wants.
   */
  it("offers to reopen the tab it already opened, rather than opening another", async () => {
    vi.mocked(clientFor).mockImplementation(
      () => pasteClient(() => new Promise(() => undefined)) as never
    );

    renderDialog();

    expect(screen.getByTestId("auth-dialog-open").textContent).toMatch(
      /^Open Gemini/
    );

    act(() => {
      fireEvent.click(screen.getByTestId("auth-dialog-open"));
    });
    await settle();

    expect(screen.getByTestId("auth-dialog-open").textContent).toMatch(
      /^Reopen Gemini/
    );
    expect(screen.getByTestId("auth-dialog-paste-scope")).toBeTruthy();
  });

  /**
   * A rejected code answered with an internal proxy path and "try again
   * later" is not something the reader can act on — it names an endpoint
   * they have never heard of, and the advice, followed immediately, is what
   * keeps a rate limit in place. The dialog owes them wording that names
   * neither.
   */
  it("explains a rate-limited exchange instead of quoting the proxy path", async () => {
    vi.mocked(clientFor).mockImplementation(
      () =>
        pasteClient(() =>
          Promise.reject(
            new OAuthError(
              "token_request_failed",
              "Token request to /api/token/gemini failed (HTTP 429): Rate limited. Please try again later.",
              { status: 429 }
            )
          )
        ) as never
    );

    renderDialog();

    act(() => {
      fireEvent.click(screen.getByTestId("auth-dialog-open"));
    });
    await settle();

    act(() => {
      fireEvent.change(screen.getByTestId("auth-dialog-paste-input"), {
        target: {
          value:
            "http://localhost:1455/oauth2callback?code=some-code&state=live-state",
        },
      });
    });

    act(() => {
      fireEvent.click(screen.getByTestId("auth-dialog-submit"));
    });
    await settle();

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).not.toContain("/api/token/gemini");
    expect(alert.textContent).toMatch(/rate-limit/i);
    expect(alert.textContent).toMatch(/wait/i);
  });
});
