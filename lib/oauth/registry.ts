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

export const PROVIDER_ORDER = [
  "openrouter",
  "openai",
  "claude",
  "gemini",
  "xai",
  "github-copilot",
  "qwen",
];
