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
 * A paste-flow client that parks at `prompt` the way Claude's really does,
 * and then answers the reader's pasted code with `reply`.
 */
function pasteClient(reply: () => Promise<TokenSet>) {
  return {
    deviceLogin: vi.fn(),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockImplementation(async (options) => {
      const started = await options.receiver.start({
        openUrl: options.openUrl,
        // Claude's real descriptor, so `manualReceiver` reads the pasted
        // `code#state` with the same parser the hook and the SDK use.
        provider: proxiedProviders.claude,
        signal: options.signal,
      });

      await started.present(
        "https://claude.ai/oauth/authorize?state=live-state"
      );
      await started.wait();

      return await reply();
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * `manage-providers.tsx` reduced to "open the dialog on Claude".
 *
 * `onOpenChange` is a `useState` setter, exactly as both real call sites
 * pass one. It matters: `AuthDialog`'s mount effect lists `startDevice`
 * among its dependencies and clears `error` when it runs, and `startDevice`
 * closes over `onOpenChange` — so an inline arrow here would give the effect
 * a new identity on every context change and silently wipe the error this
 * test is about.
 */
function Harness() {
  const [, setOpen] = useState(true);
  const { setActiveId } = useProviderAuth();
  const pickClaude = useCallback(() => setActiveId("claude"), [setActiveId]);

  return (
    <>
      <button onClick={pickClaude} type="button">
        pick claude
      </button>
      <AuthDialog onOpenChange={setOpen} open={true} />
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
    fireEvent.click(screen.getByText("pick claude"));
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
      /^Open Claude/
    );

    act(() => {
      fireEvent.click(screen.getByTestId("auth-dialog-open"));
    });
    await settle();

    expect(screen.getByTestId("auth-dialog-open").textContent).toMatch(
      /^Reopen Claude/
    );
    expect(screen.getByTestId("auth-dialog-paste-scope")).toBeTruthy();
  });

  /**
   * The error the owner actually saw, for hours, and could do nothing with:
   *
   *   Token request to /api/token/claude failed (HTTP 429): Rate limited.
   *   Please try again later.
   *
   * It names an internal proxy path, and its advice ("try again later") is
   * the opposite of useful — retrying immediately is what keeps the limit
   * hot. Verified live against Claude's real token endpoint: a single cold,
   * well-formed request carrying an invalid code is answered `429` with
   * exactly that body, so this is what a *rejected* code looks like there,
   * not evidence of a flood.
   */
  it("explains a rate-limited exchange instead of quoting the proxy path", async () => {
    vi.mocked(clientFor).mockImplementation(
      () =>
        pasteClient(() =>
          Promise.reject(
            new OAuthError(
              "token_request_failed",
              "Token request to /api/token/claude failed (HTTP 429): Rate limited. Please try again later.",
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
        target: { value: "some-code#live-state" },
      });
    });

    act(() => {
      fireEvent.click(screen.getByTestId("auth-dialog-submit"));
    });
    await settle();

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).not.toContain("/api/token/claude");
    expect(alert.textContent).toMatch(/rate-limit/i);
    expect(alert.textContent).toMatch(/wait/i);
  });
});
