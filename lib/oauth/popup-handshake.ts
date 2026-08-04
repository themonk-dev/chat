import type {
  CallbackReceiver,
  CallbackResult,
  ReceiverContext,
  StartedReceiver,
} from "@ai-oauth-sdk/browser";
import { OAuthError, readCallback } from "@ai-oauth-sdk/browser";
import { popupFeatures } from "./popup-window";

/**
 * A popup sign-in that survives the provider severing the popup.
 *
 * The SDK's own `popupReceiver` is built on two things the browser normally
 * guarantees: the popup can reach `window.opener` to post the code back, and
 * the opener can read `popup.closed` to notice the reader gave up. Anthropic
 * takes both away. `claude.ai` answers with
 *
 *     cross-origin-opener-policy: same-origin
 *
 * enforced — not the `-report-only` variant `accounts.google.com` sends —
 * which moves the popup into a fresh browsing-context group the moment it
 * lands there. From that point `window.opener` is `null` *permanently*, even
 * after the popup navigates back to our own origin, and the opener's handle
 * reports `closed === true` for a window that is plainly still on screen.
 *
 * That second half is what shipped as a bug: `popupReceiver`'s close-poller
 * read the severed handle, concluded the reader had closed the window, and
 * failed the sign-in with "the sign-in window was closed before completing"
 * about a second after the popup appeared. Nothing was closed and nothing was
 * cancelled.
 *
 * So this receiver uses neither. The callback page announces itself on a
 * `BroadcastChannel`, which is same-origin and entirely independent of who
 * opened whom — a severed opener relationship does not touch it. And there is
 * no close-poller at all: on a severed handle the signal is a lie, and the
 * dialog's own Cancel is the honest way to give up.
 *
 * `postMessage` from the opener path is still accepted, because the same
 * receiver serves providers that never sever anything (OpenRouter), and
 * because a channel that arrives twice is cheaper to ignore than a code that
 * arrives never.
 */

/**
 * The channel both halves meet on. Same-origin by construction — a
 * `BroadcastChannel` cannot cross an origin — so this carries the same
 * guarantee `postCallbackToOpener`'s explicit target origin does.
 */
export const CALLBACK_CHANNEL = "ai-oauth-chat:callback";

/** The callback page announcing a code; the opener acknowledging receipt. */
type ChannelMessage =
  | { kind: "callback"; payload: string }
  | { kind: "received" };

/**
 * Hands the callback to whichever window is waiting for it, and reports
 * whether one answered.
 *
 * The acknowledgement is not ceremony. The callback page has two very
 * different situations to tell apart — a severed popup whose opener is
 * waiting on the channel, and a reader who pasted `/callback` into their
 * address bar with nothing waiting anywhere — and `window.opener` can no
 * longer distinguish them, because the severed popup has none either. A
 * `BroadcastChannel` post is fire-and-forget, so the only way to know
 * somebody took it is for them to say so.
 */
export function announceCallback(
  payload: string,
  timeoutMs = 1500
): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const channel = new BroadcastChannel(CALLBACK_CHANNEL);
    let settled = false;

    const finish = (received: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      channel.close();
      resolve(received);
    };

    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      if (event.data?.kind === "received") {
        finish(true);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    channel.postMessage({ kind: "callback", payload } satisfies ChannelMessage);
  });
}

export type HandshakePopupOptions = {
  redirectUri: string;
  windowName?: string;
};

/**
 * Opens the provider's authorization page in a popup and waits for the code,
 * however it comes back.
 */
export function handshakePopupReceiver(
  options: HandshakePopupOptions
): CallbackReceiver {
  return {
    id: "handshake-popup",
    start(context: ReceiverContext): Promise<StartedReceiver> {
      if (typeof window === "undefined") {
        return Promise.reject(
          new OAuthError(
            "unsupported_runtime",
            "handshakePopupReceiver requires a browser window."
          )
        );
      }

      return Promise.resolve(startInBrowser(options, context));
    },
  };
}

function startInBrowser(
  options: HandshakePopupOptions,
  context: ReceiverContext
): StartedReceiver {
  let popup: Window | null = null;
  let settle: ((result: CallbackResult) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;

  const callback = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Nothing awaits this promise until `wait()` is called, and the abort below
  // can reject before that — an unhandled rejection the reader never caused.
  callback.catch(() => undefined);

  /**
   * The code, from either transport. Parsing is the SDK's (`readCallback`
   * applies the provider's own `parseCallback`), and a parse that throws is
   * the sign-in failing, not a message to ignore: a callback carrying
   * `?error=access_denied` arrives here and must surface.
   */
  const accept = (payload: string) => {
    try {
      settle?.(readCallback(context.provider, payload));
    } catch (error) {
      fail?.(error);
    }
  };

  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(CALLBACK_CHANNEL);

  if (channel) {
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      if (event.data?.kind !== "callback") {
        return;
      }

      // Acknowledged before parsing, so a callback the SDK rejects still
      // closes the window that delivered it rather than stranding it.
      channel.postMessage({ kind: "received" } satisfies ChannelMessage);
      accept(event.data.payload);
    };
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    const data = event.data as { type?: string; payload?: string } | null;

    if (data?.type !== "aioauth:callback" || typeof data.payload !== "string") {
      return;
    }

    accept(data.payload);
  };

  window.addEventListener("message", onMessage);

  const cleanup = () => {
    window.removeEventListener("message", onMessage);
    channel?.close();
    context.signal?.removeEventListener("abort", onAbort);
  };

  function onAbort() {
    fail?.(new OAuthError("aborted", "Login was aborted."));
    closePopup();
  }

  /**
   * A handle severed by COOP answers `close()` with nothing at all, and may
   * throw depending on the engine. The sign-in is over either way by the time
   * this runs, so a window we cannot close is not a failure.
   */
  function closePopup() {
    try {
      if (popup && !popup.closed) {
        popup.close();
      }
    } catch {
      // Not a failed sign-in.
    }
  }

  context.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    close() {
      cleanup();
      closePopup();

      return Promise.resolve();
    },
    present(url: string) {
      popup = window.open(
        url,
        options.windowName ?? "aioauth-login",
        popupFeatures()
      );

      if (!popup) {
        cleanup();

        return Promise.reject(
          new OAuthError(
            "unsupported_runtime",
            "The popup was blocked. Allow popups for this site and try again."
          )
        );
      }

      return Promise.resolve();
    },
    redirectUri: options.redirectUri,
    wait: () => callback,
  };
}
