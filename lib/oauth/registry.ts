/**
 * How each provider signs in, and what to call it on screen. The flow is what
 * the provider's registered client permits, not a preference.
 *
 * `device` needs no redirect URI, so it works on any origin — but only four of
 * the seven declare one. `popup` needs the provider to redirect back to *our*
 * origin, which only OpenRouter accepts unconditionally. `paste` is the
 * fallback for a client registered solely for loopback or its own hosted page.
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
      "Claude shows you a code once you approve. Copy it and paste it here.",
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
 * An exact allow-list rather than a suffix test, because `app.localhost`
 * resolves to loopback and Google still rejects it. The scheme is not checked:
 * `https://localhost:PORT/callback` is accepted too.
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

/** Passed into `flowFor` explicitly so "there is no origin" is testable. */
export function currentOrigin(): { hostname: string } | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

/**
 * Providers whose authorization page sends an enforced COOP `same-origin`,
 * severing the popup: `window.opener` becomes permanently `null` and our handle
 * reports `closed` for a window still on screen. See `./popup-handshake`.
 */
export const SEVERING_AUTH_PAGES = new Set(["claude"]);

/**
 * The two whose published clients register a loopback redirect and nothing a
 * deployed origin can use. On loopback our own `/callback` qualifies (RFC 8252
 * ignores the port) so the popup completes by itself; anywhere else the
 * provider answers `redirect_uri_mismatch` — or, for Anthropic, "Redirect URI
 * … is not supported by client" — so the flow falls back to paste.
 *
 * The device grant is the only one needing no redirect URI, and it is what puts
 * ChatGPT, Copilot, Grok and Qwen on every origin. Both auth servers have that
 * endpoint; both refuse these clients, probed live:
 *
 *   POST platform.claude.com/v1/oauth/device_authorization -> unauthorized_client
 *     (an unknown client id answers invalid_client, so the grant is disabled
 *     for this one rather than the request being malformed)
 *   POST oauth2.googleapis.com/device/code -> invalid_client, "Invalid client type."
 *
 * So paste is not a stopgap here. Changing it needs a client we register
 * ourselves, not a different flow.
 */
const LOOPBACK_POPUP_PROVIDERS = new Set(["claude", "gemini"]);

/** The declared flow, except on loopback for the two providers above. */
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
