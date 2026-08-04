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
 * and the answers do not follow the rule you would guess:
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
 * The flow to actually run for a provider here, which is the declared one for
 * everybody except Gemini.
 *
 * Gemini's descriptor declares `redirect: { mode: 'loopback', loopbackPort: 0
 * }` — a loopback redirect on any free port, which a CLI serves by binding
 * one. A browser cannot bind anything, which is why Gemini falls back to
 * pasting the address bar out of a `localhost` URL that failed to load.
 *
 * But in development this app *is* served from a loopback address, and that
 * changes what it can offer Google: a loopback redirect on an arbitrary port
 * (RFC 8252) pointed at our own `/callback`, which is same-origin with the
 * opener, runs `postCallbackToOpener()` and closes itself. That is the
 * OpenRouter path exactly, and it is a far better experience than copying a
 * URL out of a broken tab.
 *
 * It cannot follow the app to production, and that is not a detail to fix
 * later — it is why this is a branch and not a change to the registry.
 * `https://chat.themonk.dev/callback` is answered `redirect_uri_mismatch` by
 * Google (probed live) because a Desktop-app client is not permitted an HTTPS
 * redirect, and a loopback redirect cannot reach a remote origin either. So
 * anywhere but loopback, the paste flow the site ships today is the only one
 * that works, and it stays.
 *
 * Registering a Google "Web application" client with an HTTPS redirect URI
 * would remove the limitation and make this branch unnecessary — that is the
 * owner's call to make, since it means publishing a second client id, not
 * something to take on their behalf here.
 */
export function flowFor(
  providerId: string,
  origin: { hostname: string } | undefined
): Flow {
  const declared = registry[providerId].flow;

  if (providerId === "gemini" && isLoopbackOrigin(origin)) {
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
