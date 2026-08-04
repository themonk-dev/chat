import type {
  CallbackReceiver,
  CallbackResult,
  ReceiverContext,
  StartedReceiver,
} from "@ai-oauth-sdk/browser";
import { OAuthError, readCallback } from "@ai-oauth-sdk/browser";
import { CALLBACK_CHANNEL, type ChannelMessage } from "./callback-channel";
import { popupFeatures } from "./popup-window";

/**
 * A popup sign-in that survives the provider severing the popup.
 *
 * `claude.ai` sends an enforced `Cross-Origin-Opener-Policy: same-origin`, so
 * `window.opener` is permanently `null` and our handle reports `closed === true`
 * for a window still on screen. The SDK's own `popupReceiver` is built on both
 * signals, and its close-poller failed every Claude sign-in a second after it
 * opened. This uses a `BroadcastChannel` instead, and never polls `.closed`.
 */

export type HandshakePopupOptions = {
  redirectUri: string;
  windowName?: string;
};

/** A severed handle may throw on `close()`, and the sign-in is over by then. */
function closeQuietly(popup: Window | null): void {
  try {
    if (popup && !popup.closed) {
      popup.close();
    }
  } catch {
    // Not a failed sign-in.
  }
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

  // Nothing awaits this until `wait()` is called, and the abort below can
  // reject before that — an unhandled rejection the reader never caused.
  callback.catch(() => undefined);

  // A parse that throws is the sign-in failing, not a message to ignore: a
  // callback carrying `?error=access_denied` arrives here and must surface.
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

  function onAbort() {
    fail?.(new OAuthError("aborted", "Login was aborted."));
    closeQuietly(popup);
  }

  const cleanup = () => {
    window.removeEventListener("message", onMessage);
    channel?.close();
    context.signal?.removeEventListener("abort", onAbort);
  };

  window.addEventListener("message", onMessage);
  context.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    close() {
      cleanup();
      closeQuietly(popup);

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
