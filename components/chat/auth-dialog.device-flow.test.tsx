import type { TokenSet } from "@ai-oauth-sdk/browser";
import { popupReceiver } from "@ai-oauth-sdk/browser";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderAuthProvider,
  useProviderAuth,
} from "@/hooks/use-provider-auth";
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

type DeviceLoginOptions = {
  onCode: (device: { userCode: string; verificationUri: string }) => void;
  signal: AbortSignal;
};

const QWEN_TOKENS: TokenSet = {
  accessToken: "qwen-token",
  provider: "qwen",
  raw: {},
  tokenType: "bearer",
};

/**
 * A device flow that hands over its code and then waits, the way a real one
 * waits on the reader approving it elsewhere. `approve()` is the poll
 * succeeding; the signal rejecting is the reader walking away.
 */
function deferredDeviceClient() {
  const approvals: (() => void)[] = [];
  const signals: AbortSignal[] = [];

  const deviceLogin = vi.fn(
    ({ onCode, signal }: DeviceLoginOptions) =>
      new Promise<TokenSet>((resolve, reject) => {
        signals.push(signal);
        onCode({
          userCode: "TCUCZE0G",
          verificationUri: "https://chat.qwen.ai/device",
        });
        approvals.push(() => resolve(QWEN_TOKENS));
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted by signal")),
          { once: true }
        );
      })
  );

  return {
    approve: () => {
      for (const resolve of approvals) {
        resolve();
      }
    },
    client: {
      deviceLogin,
      getTokens: vi.fn().mockResolvedValue(undefined),
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    deviceLogin,
    signals,
  };
}

function stubQwenClient(device: ReturnType<typeof deferredDeviceClient>) {
  vi.mocked(clientFor).mockImplementation(
    (id: string) =>
      (id === "qwen"
        ? device.client
        : {
            deviceLogin: vi.fn(() => new Promise(() => undefined)),
            getTokens: vi.fn().mockResolvedValue(undefined),
            login: vi.fn(),
            logout: vi.fn().mockResolvedValue(undefined),
          }) as never
  );
}

/**
 * `suggested-actions.tsx` reduced to what these cases ride on: the dialog is
 * opened for the provider that is *already* active, so nothing calls
 * `setActiveId` when it closes. That is the shape of the real leak — the
 * restore path in `manage-providers.tsx` is skipped entirely when
 * `id === activeId`.
 */
function Harness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { activeId, setActiveId } = useProviderAuth();

  const handleConnect = useCallback(() => {
    setActiveId("qwen");
    setDialogOpen(true);
  }, [setActiveId]);

  return (
    <>
      <button data-testid="connect-qwen" onClick={handleConnect} type="button">
        Connect Qwen
      </button>
      <AuthDialog
        key={activeId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

/** Lets every pending microtask and timer settle inside `act`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The parts of a `WindowProxy` this component is allowed to touch. */
function fakeWindow(closed = false) {
  return { close: vi.fn(), closed, focus: vi.fn() };
}

/**
 * The exact window features `popupReceiver` passes to `window.open`, taken
 * from the receiver itself rather than restated as a literal here.
 *
 * The owner's request was that the device flows open "just like what we do
 * for openrouter", and OpenRouter's window is opened by that receiver — so
 * the honest assertion is that the two calls agree, not that ours matches a
 * string a test author copied across once and could not keep in step. This
 * drives the real receiver (this file never mocks the SDK) the way
 * `AuthClient.login()` does, and reads the third argument back off the spy.
 */
async function popupReceiverFeatures(): Promise<string> {
  const opened = fakeWindow();
  const open = vi
    .spyOn(window, "open")
    .mockReturnValue(opened as unknown as Window);

  const started = await popupReceiver().start({
    provider: { id: "openrouter" },
  } as never);

  await started.present("https://example.com/authorize");

  const features = String(open.mock.calls[0]?.[2]);

  await started.close();
  open.mockRestore();

  return features;
}

async function openDialogForQwen(
  device: ReturnType<typeof deferredDeviceClient>
) {
  stubQwenClient(device);

  render(
    <ProviderAuthProvider>
      <Harness />
    </ProviderAuthProvider>
  );

  fireEvent.click(screen.getByTestId("connect-qwen"));
  await settle();

  expect(screen.getByTestId("device-code").textContent).toBe("TCUCZE0G");
}

describe("closing the provider window after a device flow", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The feature request, as the owner put it: the provider tab should close
   * itself the moment the main window has the token, the way OpenRouter's
   * popup already does. A window opened by `window.open` can be closed by
   * its opener whatever origin it has since navigated to.
   */
  it("closes the verification window it opened once the poll succeeds", async () => {
    const opened = fakeWindow();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(opened as unknown as Window);
    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByTestId("device-verification-link"));

    expect(open).toHaveBeenCalledWith(
      "https://chat.qwen.ai/device",
      "aioauth-verify-qwen",
      expect.stringContaining("popup=yes")
    );

    act(() => device.approve());
    await settle();

    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("device-code")).toBeNull();
  });

  /**
   * The reader closed the tab themselves before approving elsewhere (another
   * device, say). `close()` on an already-closed window is harmless, but
   * calling it says something untrue about what happened — and the sign-in
   * that already succeeded must land either way.
   */
  it("leaves an already-closed window alone, and still signs in", async () => {
    const opened = fakeWindow(true);

    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByTestId("device-verification-link"));

    act(() => device.approve());
    await settle();

    expect(opened.close).not.toHaveBeenCalled();
    expect(screen.queryByTestId("device-code")).toBeNull();
  });

  /**
   * Copying the code and approving it on a phone is a supported way through
   * this flow — there is no window to close, and nothing may break because
   * of it.
   */
  it("signs in normally when no verification window was ever opened", async () => {
    const open = vi.spyOn(window, "open");
    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    act(() => device.approve());
    await settle();

    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("device-code")).toBeNull();
  });

  /**
   * A popup blocker (or any runtime that hands back no handle) is the same
   * case as never opening one: the anchor's own `target="_blank"` is left to
   * do the navigating, and the sign-in is untouched.
   */
  it("falls back to the anchor when window.open yields no handle", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    const link = screen.getByTestId("device-verification-link");
    const defaultPrevented = !fireEvent.click(link);

    expect(defaultPrevented).toBe(false);

    act(() => device.approve());
    await settle();

    expect(screen.queryByTestId("device-code")).toBeNull();
  });

  /**
   * Closing must never be able to fail a sign-in that already succeeded. A
   * `close()` that throws — a severed proxy, an exotic runtime — is swallowed
   * and the token still lands.
   */
  it("survives a close() that throws", async () => {
    const opened = {
      close: vi.fn(() => {
        throw new Error("cannot close");
      }),
      closed: false,
    };

    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByTestId("device-verification-link"));

    act(() => device.approve());
    await settle();

    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("device-code")).toBeNull();
  });
});

describe("opening a device verification page", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The owner's request, in their words: "can we open copilot, x and chatgpt
   * in a new pop up with a loader not tab, just like what we do for
   * openrouter". A full tab pushes the app out of view and leaves the reader
   * to find their way back; the popup keeps the dialog — and the code — on
   * screen beside it.
   *
   * "Just like" is asserted against `popupReceiver`'s own call rather than
   * against numbers restated here, so the two windows cannot drift apart.
   */
  it("opens the verification page in a popup shaped exactly like the one popupReceiver opens", async () => {
    const features = await popupReceiverFeatures();
    const opened = fakeWindow();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(opened as unknown as Window);
    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByTestId("device-verification-link"));

    expect(open).toHaveBeenCalledWith(
      "https://chat.qwen.ai/device",
      expect.any(String),
      features
    );
    expect(features).toMatch(
      /^popup=yes,width=\d+,height=\d+,left=\d+,top=\d+$/
    );
  });

  /**
   * A stable window name is what makes a second click reuse the window that
   * is already open instead of stacking another beside it — the same trade
   * `use-provider-auth.tsx`'s `tabNameFor` makes for the paste flow. `_blank`
   * (what this used to pass) opts out of exactly that.
   */
  it("reuses one named window per provider rather than stacking new ones", async () => {
    const opened = fakeWindow();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(opened as unknown as Window);
    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByTestId("device-verification-link"));
    fireEvent.click(screen.getByTestId("device-verification-link"));

    expect(open.mock.calls.map((call) => call[1])).toEqual([
      "aioauth-verify-qwen",
      "aioauth-verify-qwen",
    ]);
  });

  /**
   * The "with a loader" half of the request. There is nothing to load in the
   * popup that this page could speak for — it is the provider's own page,
   * cross-origin — so the loader belongs where the truth is: the dialog,
   * which is genuinely polling the provider every few seconds until the code
   * is approved. It appears only once a window has actually been opened,
   * because before that the reader is the one being waited on, not us.
   */
  it("shows a waiting indicator only once the verification window is open", async () => {
    const opened = fakeWindow();

    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    expect(screen.queryByTestId("device-waiting")).toBeNull();

    fireEvent.click(screen.getByTestId("device-verification-link"));
    await settle();

    const waiting = screen.getByTestId("device-waiting");

    expect(waiting.textContent).toMatch(/waiting/i);
    expect(waiting.querySelector('[role="status"]')).toBeTruthy();
    expect(screen.getByTestId("device-verification-link").textContent).toMatch(
      /reopen/i
    );
  });

  /**
   * A popup blocker hands back no handle, and the anchor's own
   * `target="_blank"` is left to do the navigating — the reader gets a tab,
   * which is worse but works. Claiming to be waiting on a window that was
   * never opened would be the lie the loader must not tell.
   */
  it("claims no window when the popup was blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    const link = screen.getByTestId("device-verification-link");
    const defaultPrevented = !fireEvent.click(link);

    await settle();

    expect(defaultPrevented).toBe(false);
    expect(screen.queryByTestId("device-waiting")).toBeNull();
  });
});

describe("abandoning a device flow", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The 403 loop, exactly as it was observed.
   *
   * OpenAI's device endpoint answers 403 for "not approved yet", so a live
   * poll is a 403 every five seconds until it is either approved or aborted.
   * Nothing aborted it: `manage-providers.tsx` only restores — and therefore
   * only calls `setActiveId`, the one thing that aborts — when the dialog was
   * opened for a *different* provider than the active one. Connecting the
   * provider you are already on, or connecting from the disconnected notice
   * in `suggested-actions.tsx`, skipped that entirely, so closing the dialog
   * left the poll hammering the provider's auth endpoint for the full
   * fifteen-minute life of the code. That is how an origin earns a rate
   * limit, and it is not a dev-only path.
   */
  it("aborts the poll when the dialog is closed with nothing to restore", async () => {
    const device = deferredDeviceClient();

    await openDialogForQwen(device);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();

    expect(device.signals).toHaveLength(1);
    expect(device.signals[0].aborted).toBe(true);
  });

  /**
   * StrictMode mounts, unmounts and remounts every effect in development.
   * The device request goes out from a mount effect, so it goes out twice —
   * and before the cleanup below existed, the first attempt's controller was
   * overwritten by the second and could never be aborted by anything. It
   * polled on, invisible, for the life of the code.
   *
   * The cleanup makes the pair symmetric: whatever a mount started, the
   * matching unmount stops. Two requests are still made in development, but
   * only ever one of them is live.
   */
  it("leaves exactly one live attempt under StrictMode", async () => {
    const device = deferredDeviceClient();

    stubQwenClient(device);

    render(
      <StrictMode>
        <ProviderAuthProvider>
          <Harness />
        </ProviderAuthProvider>
      </StrictMode>
    );

    fireEvent.click(screen.getByTestId("connect-qwen"));
    await settle();

    expect(device.signals.filter((signal) => !signal.aborted)).toHaveLength(1);
  });
});
