/**
 * How each provider signs in, and what to call it on screen. The flow is what
 * the provider's registered client permits, not a preference.
 */
export type Flow = "device" | "paste" | "popup";

export const registry: Record<
  string,
  { flow: Flow; label: string; pasteHint?: string }
> = {
  // Anthropic accepts an HTTPS `/callback` for the published Claude Code
  // client (probed live), unlike Google's Desktop-app client.
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
 * Gemini's Desktop-app client only accepts a loopback redirect, so on loopback
 * our own `/callback` page qualifies (RFC 8252 ignores the port) and the popup
 * works. In production Google answers `redirect_uri_mismatch`, hence paste.
 */
const LOOPBACK_POPUP_PROVIDERS = new Set(["gemini"]);

/** The declared flow for everybody but Gemini. */
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
