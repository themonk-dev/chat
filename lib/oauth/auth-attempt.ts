import {
  isOAuthError,
  OAuthError,
  parseStandardCallback,
} from "@ai-oauth-sdk/browser";
import { openPopup } from "./popup-window";
import { proxiedProviders } from "./providers";

/**
 * One paste attempt and everything that ends with it: the promise
 * `manualReceiver` is blocked on, the whole `login()` call, its own abort
 * handle, the `state` a pasted code is attributed to, and the tab it opened.
 */
export type PasteAttempt = {
  completion: Promise<void>;
  controller: AbortController;
  resolveInput: (value: string) => void;
  state: string | undefined;
  tab: Window | null;
  url: string;
};

/**
 * A stable name lets a second `window.open` reuse the tab already on screen
 * instead of stacking another beside it.
 */
export function tabNameFor(providerId: string): string {
  return `aioauth-authorize-${providerId}`;
}

/**
 * A popup rather than a tab, so the reader can see the code and the dialog they
 * are pasting it into at once — the same window the device flows open.
 *
 * `noopener` is deliberately not passed: it is what makes `window.open` return
 * `null` and the browser ignore the window name, so there is no version of this
 * that severs the opener and can still focus or close its own window.
 */
export function openAuthorizationTab(
  url: string,
  providerId: string
): Window | null {
  return openPopup(url, tabNameFor(providerId));
}

export function stateOfAuthorizationUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("state") ?? undefined;
  } catch {
    // An unparseable URL simply has no state to attribute a paste to.
  }
}

/**
 * Read with the provider's own `parseCallback`, so this cannot disagree with
 * the SDK's timing-safe comparison moments later. Nothing rides on it beyond
 * which message the reader gets.
 */
export function stateOfPastedValue(
  providerId: string,
  value: string
): string | undefined {
  const parse =
    proxiedProviders[providerId]?.parseCallback ?? parseStandardCallback;

  try {
    return parse(value)?.state;
  } catch {
    // A value the parser chokes on is left for the SDK to reject.
  }
}

/** Closes a tab this hook opened, if there is still one of ours to close. */
export function closeTab(attempt: PasteAttempt): void {
  const { tab } = attempt;

  attempt.tab = null;

  if (!tab) {
    return;
  }

  try {
    if (!tab.closed) {
      tab.close();
    }
  } catch {
    // A window we cannot close is not a failed sign-in.
  }
}

/**
 * A cancelled attempt rejects with whatever the abort happened to interrupt —
 * the SDK's `aborted` error between polls, a bare `AbortError` `DOMException`
 * from a poll on the wire. `signal.aborted` records "we cancelled this"
 * regardless, so callers never have to classify cancellation by shape.
 */
export function asCancellation(
  controller: AbortController,
  error: unknown
): unknown {
  if (!controller.signal.aborted) {
    return error;
  }

  return isOAuthError(error) && error.code === "aborted"
    ? error
    : new OAuthError("aborted", "The sign-in was cancelled.");
}
