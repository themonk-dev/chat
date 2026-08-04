/**
 * How each provider signs in, and what to call it on screen.
 *
 * The flow is not a preference — it is what the provider's registered client
 * permits. These are CLI client ids registered for loopback or device use, so a
 * remote HTTPS callback is rejected by all but OpenRouter, whose key endpoint
 * accepts any callback URL.
 */
export type Flow = "device" | "paste" | "popup";

export const registry: Record<
  string,
  { flow: Flow; label: string; pasteHint?: string }
> = {
  /**
   * Anthropic accepts `https://<our origin>/callback` as a redirect URI for
   * the published Claude Code client — probed live against the real
   * authorization endpoint with a signed-in account, where
   * `https://chat.themonk.dev/callback` reached the consent screen rather
   * than a `redirect_uri_mismatch`. It is not restricted to loopback and its
   * own hosted page the way Google's Desktop-app client is, so the popup
   * works on the deployed site and there is nothing to paste anywhere.
   */
  claude: { flow: "popup", label: "Claude" },
  gemini: {
    flow: "paste",
    label: "Gemini",
    pasteHint:
      "Google redirects to a localhost URL that will not load. Copy the whole address bar and paste it here.",
  },
  "github-copilot": { flow: "device", label: "GitHub Copilot" },
  openai: { flow: "device", label: "ChatGPT" },
  openrouter: { flow: "popup", label: "OpenRouter" },
  qwen: { flow: "device", label: "Qwen" },
  xai: { flow: "device", label: "Grok" },
};

/**
 * Whether this page is served from an address Google will redirect a
 * Desktop-app OAuth client back to.
 *
 * Deliberately an allow-list of three exact hostnames rather than anything
 * cleverer, because each was probed against Google's real authorization
 * endpoint with the published gemini-cli client id and a `/callback` path,
 * and the answers do not follow the rule you would guess. Anthropic's client
 * is registered for loopback the same way and is held to the same list —
 * its endpoint sits behind a bot challenge that answers before any OAuth
 * validation does, so it cannot be probed the way Google's was, and
 * inheriting a list that is known to be *narrower* than the RFC is the safe
 * direction to be wrong in:
 *
 * - `localhost`, `127.0.0.1`, `[::1]` — reach the account chooser. Accepted.
 * - `app.localhost` — `invalid_request`, "doesn't comply with Google's OAuth
 *   2.0 policy". It resolves to the loopback interface and is still not a
 *   loopback redirect, so a test for a `localhost` suffix would have shipped
 *   a sign-in that always fails.
 * - `chat.themonk.dev` over HTTPS — `redirect_uri_mismatch`, which is the
 *   constraint the whole branch exists for.
 *
 * The scheme is not checked: `https://localhost:PORT/callback` was probed too
 * and is also accepted, so requiring `http:` would refuse a setup that works.
 * `[::1]` is how `location.hostname` reports an IPv6 literal (brackets and
 * all); the bare form is accepted for callers holding a parsed host.
 */
export function isLoopbackOrigin(
  origin: { hostname: string } | undefined
): boolean {
  if (!origin) {
    return false;
  }

  return (
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]" ||
    origin.hostname === "::1"
  );
}

/**
 * The origin this is running on, or nothing when it is running on a server.
 *
 * Passed into `flowFor` explicitly rather than read inside it, so that "there
 * is no origin" is a value a test can hand over — jsdom's `window.location`
 * is unforgeable, so a defaulted parameter would make the server case the one
 * branch no test could reach.
 */
export function currentOrigin(): { hostname: string } | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

/**
 * Providers whose authorization page sends an enforced
 * `Cross-Origin-Opener-Policy: same-origin`, and so severs the popup from the
 * window that opened it.
 *
 * Anthropic does. `claude.ai` answers with COOP `same-origin` *enforced* —
 * not the `-report-only` variant `accounts.google.com` sends, which reports
 * and severs nothing — so the moment the popup lands there the browser moves
 * it into a browsing-context group of its own. `window.opener` becomes `null`
 * permanently, including after the popup returns to our own origin, and our
 * handle on it reports `closed === true` for a window still plainly on
 * screen.
 *
 * Both halves matter, and the second one shipped as a bug: the SDK's
 * `popupReceiver` polls `popup.closed` to notice a reader giving up, read the
 * severed handle, and failed the sign-in with "the sign-in window was closed
 * before completing" about a second after the popup opened. See
 * `lib/oauth/popup-handshake.ts`, which uses neither signal.
 */
export const SEVERING_AUTH_PAGES = new Set(["claude"]);

/**
 * The one provider whose registered client accepts a loopback redirect and
 * nothing else useful to a browser.
 *
 * Gemini declares `redirect: { mode: 'loopback', loopbackPort: 0 }` — a
 * loopback redirect on any free port, which a CLI serves by binding one. A
 * browser cannot bind anything, which is why it otherwise falls back to
 * copying the address bar out of a `localhost` URL that failed to load.
 *
 * On loopback there is a better option, and it is the one the descriptor was
 * written for. RFC 8252 has the port component ignored at registration, so
 * `http://localhost:<whatever>/callback` is a registered URI — and here that
 * address is *our own* `/callback` page, which hands the code back and closes
 * itself. That is the OpenRouter path exactly.
 *
 * It cannot follow the app to production: `https://chat.themonk.dev/callback`
 * is answered `redirect_uri_mismatch` by Google (probed live) because a
 * Desktop-app client is not permitted an HTTPS redirect. Registering a Google
 * "Web application" client would remove the limitation — that is the owner's
 * call, since it means publishing a second client id.
 *
 * Claude used to be here too, on the assumption that Anthropic's client was
 * registered the same way. It is not: `https://chat.themonk.dev/callback`
 * reaches Anthropic's consent screen (probed live, signed in), so Claude is a
 * plain popup provider on every origin and needs no exception at all.
 */
const LOOPBACK_POPUP_PROVIDERS = new Set(["gemini"]);

/**
 * The flow to actually run for a provider here, which is the declared one for
 * everybody but Gemini.
 */
export function flowFor(
  providerId: string,
  origin: { hostname: string } | undefined
): Flow {
  const declared = registry[providerId].flow;

  if (LOOPBACK_POPUP_PROVIDERS.has(providerId) && isLoopbackOrigin(origin)) {
    return "popup";
  }

  return declared;
}

export const PROVIDER_ORDER = [
  "openrouter",
  "openai",
  "claude",
  "gemini",
  "xai",
  "github-copilot",
  "qwen",
];
