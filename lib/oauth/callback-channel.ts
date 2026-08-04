/** Same-origin by construction — a `BroadcastChannel` cannot cross an origin. */
export const CALLBACK_CHANNEL = "ai-oauth-chat:callback";

/** The callback page announcing a code; the opener acknowledging receipt. */
export type ChannelMessage =
  | { kind: "callback"; payload: string }
  | { kind: "received" };

const ACKNOWLEDGEMENT_TIMEOUT_MS = 1500;

/**
 * A `BroadcastChannel` post is fire-and-forget, so the acknowledgement is the
 * only way the callback page can tell a waiting opener from nobody at all —
 * `window.opener` is `null` in both cases once COOP has severed the popup.
 */
export function announceCallback(
  payload: string,
  timeoutMs = ACKNOWLEDGEMENT_TIMEOUT_MS
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
