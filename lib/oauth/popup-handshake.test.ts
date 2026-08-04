import type { ProviderConfig } from "@ai-oauth-sdk/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxiedProviders } from "./providers";

/**
 * The receiver exists because Anthropic severs the popup, and every test here
 * is written against that severing rather than around it.
 *
 * A severed popup is not a subtle state. `window.opener` is `null` inside it
 * forever after, and the opener's own handle answers `closed === true` for a
 * window the reader is looking at. So the two mechanisms the SDK's
 * `popupReceiver` is built on — `postMessage` through the opener, and a
 * `.closed` poll to notice the reader giving up — do not merely degrade here.
 * One never fires and the other lies, which is how a working sign-in came to
 * report itself cancelled a second after the popup opened.
 *
 * jsdom implements neither COOP nor `BroadcastChannel` severing, so these
 * tests cannot reproduce the browser's swap. What they can pin is that the
 * receiver never consults the signals that the swap corrupts, and that the
 * channel path alone is enough to complete a sign-in — which is exactly the
 * behaviour the browser's swap leaves standing.
 */

const { announceCallback, CALLBACK_CHANNEL, handshakePopupReceiver } =
  await import("./popup-handshake");

const provider = proxiedProviders.claude as ProviderConfig;

type FakePopup = { close: () => void; closed: boolean };

const originalOpen = window.open;

afterEach(() => {
  window.open = originalOpen;
  vi.useRealTimers();
});

/** A popup that reports itself closed, the way a severed handle does. */
function stubOpen(closed: boolean): FakePopup {
  const popup: FakePopup = {
    close: () => {
      popup.closed = true;
    },
    closed,
  };

  window.open = (() => popup as unknown as Window) as typeof window.open;

  return popup;
}

async function start(signal?: AbortSignal) {
  const started = await handshakePopupReceiver({
    redirectUri: "https://chat.themonk.dev/callback",
    windowName: "test-popup",
  }).start({ provider, ...(signal ? { signal } : {}) });

  return started;
}

describe("handshakePopupReceiver", () => {
  it("completes from the channel alone, with no opener involved", async () => {
    stubOpen(false);
    const started = await start();
    await started.present("https://claude.ai/oauth/authorize");

    const delivered = announceCallback("?code=the-code&state=the-state");

    await expect(started.wait()).resolves.toEqual({
      code: "the-code",
      state: "the-state",
    });
    await expect(delivered).resolves.toBe(true);

    await started.close();
  });

  /**
   * The regression that shipped. A handle severed by COOP answers `closed`
   * with `true` immediately, and any receiver that treats that as the reader
   * giving up fails a sign-in nobody cancelled. The popup here reports itself
   * closed from the moment it is opened; the callback still lands.
   */
  it("does not treat an already-closed handle as a cancellation", async () => {
    stubOpen(true);
    const started = await start();
    await started.present("https://claude.ai/oauth/authorize");

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    announceCallback("?code=late-code&state=late-state");

    await expect(started.wait()).resolves.toEqual({
      code: "late-code",
      state: "late-state",
    });

    await started.close();
  });

  /**
   * The reader's Cancel, which is the only cancellation left once `.closed`
   * is untrustworthy — so it has to actually reach the promise `login()` is
   * waiting on.
   */
  it("rejects when the attempt is aborted", async () => {
    stubOpen(false);
    const controller = new AbortController();
    const started = await start(controller.signal);
    await started.present("https://claude.ai/oauth/authorize");

    controller.abort();

    await expect(started.wait()).rejects.toThrow("Login was aborted.");

    await started.close();
  });

  /**
   * A callback carrying `?error=…` is the sign-in failing, and it arrives on
   * the same channel a successful one does. Swallowing it as an unparseable
   * message would leave the dialog waiting forever on a flow the provider has
   * already ended.
   */
  it("surfaces a provider error rather than waiting on it", async () => {
    stubOpen(false);
    const started = await start();
    await started.present("https://claude.ai/oauth/authorize");

    announceCallback("?error=access_denied&error_description=Denied");

    await expect(started.wait()).rejects.toThrow(/access_denied|Denied/);

    await started.close();
  });

  it("reports a blocked popup instead of waiting on a window that never opened", async () => {
    window.open = (() => null) as typeof window.open;
    const started = await start();

    await expect(
      started.present("https://claude.ai/oauth/authorize")
    ).rejects.toThrow(/popup was blocked/i);
  });

  it("carries the redirect URI it was given", async () => {
    stubOpen(false);
    const started = await start();

    expect(started.redirectUri).toBe("https://chat.themonk.dev/callback");

    await started.close();
  });
});

describe("announceCallback", () => {
  /**
   * The distinction the callback page cannot make any other way. A severed
   * popup and a reader who typed `/callback` into the address bar both have
   * no opener; only one of them has a window waiting on the channel. Without
   * an acknowledgement the page would either strand a real sign-in or
   * redirect a real one home.
   */
  it("reports no listener when nothing is waiting", async () => {
    vi.useFakeTimers();
    const delivered = announceCallback("?code=nobody-home", 1000);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(delivered).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("acknowledges over the channel every side agrees on", async () => {
    stubOpen(false);
    const started = await start();
    await started.present("https://claude.ai/oauth/authorize");

    const channel = new BroadcastChannel(CALLBACK_CHANNEL);
    const acknowledged = new Promise<boolean>((resolve) => {
      channel.onmessage = (event: MessageEvent<{ kind: string }>) => {
        if (event.data?.kind === "received") {
          resolve(true);
        }
      };
    });

    channel.postMessage({ kind: "callback", payload: "?code=c&state=s" });

    await expect(acknowledged).resolves.toBe(true);

    channel.close();
    await started.close();
  });
});
