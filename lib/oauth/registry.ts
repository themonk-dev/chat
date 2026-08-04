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
  claude: {
    flow: "paste",
    label: "Claude",
    pasteHint:
      "Anthropic shows the code on its own page. Copy it and paste it here.",
  },
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
 * The two providers whose registered client accepts a loopback redirect, and
 * which therefore need nothing pasted when this app is itself served from
 * one.
 *
 * Both declare `redirect: { mode: 'loopback', loopbackPort: 0 }` in their SDK
 * descriptors — a loopback redirect on any free port, which a CLI serves by
 * binding one. A browser cannot bind anything, which is why each falls back
 * to a paste: Gemini to copying the address bar out of a `localhost` URL that
 * failed to load, Claude to copying the `CODE#STATE` string Anthropic prints
 * on its hosted callback page.
 *
 * On loopback there is a third option, and it is the one both descriptors
 * were written for. RFC 8252 has the port component of a loopback redirect
 * ignored at registration, so `http://localhost:<whatever>/callback` is a
 * registered URI for both — and here that address is *our own* `/callback`
 * page, same-origin with the opener, which runs `postCallbackToOpener()` and
 * closes itself. That is the OpenRouter path exactly.
 *
 * Neither can follow the app to production, and that is not a detail to fix
 * later. `https://chat.themonk.dev/callback` is answered
 * `redirect_uri_mismatch` by Google (probed live) because a Desktop-app
 * client is not permitted an HTTPS redirect, and Anthropic's client is
 * registered the same way — a loopback redirect cannot reach a remote origin
 * under either. So anywhere but loopback the paste flow stays, and it stays
 * for a reason, not as a leftover.
 *
 * Registering a Google "Web application" client with an HTTPS redirect URI
 * would remove half the limitation — that is the owner's call to make, since
 * it means publishing a second client id. Anthropic offers no such option:
 * its hosted callback page is the only non-loopback redirect it accepts, and
 * that page is cross-origin, so a popup opened onto it can be closed by us
 * but never read. There is no version of this that works on the deployed
 * site.
 */
const LOOPBACK_POPUP_PROVIDERS = new Set(["claude", "gemini"]);

/**
 * The flow to actually run for a provider here, which is the declared one for
 * everybody but the two above.
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
