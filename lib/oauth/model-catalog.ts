export type Model = { id: string; name: string };

/** One provider's models as the picker shows them: live if fetched, else static. */
export type ModelGroup = { models: Model[]; providerId: string };

/**
 * The first entry of each list is that provider's default — the model a reader
 * is put on, and billed for, the moment they connect. Order here is behaviour,
 * not presentation, and `models.test.ts` pins all seven defaults by id.
 *
 * Gemini is the one provider with no live listing to fall back from: Code
 * Assist is RPC-shaped, and its `fetchAvailableModels` answers 403 for a
 * gemini-cli token.
 */
const MODELS: Record<string, Model[]> = {
  claude: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  // Flash first: Pro's free Code Assist quota is a fraction of Flash's, so
  // defaulting to Pro exhausts a free account immediately.
  gemini: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  "github-copilot": [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  ],
  // Codex first: this surface is the Codex backend, not the general API.
  openai: [
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5", name: "GPT-5" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", name: "GPT-5" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  qwen: [{ id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" }],
  xai: [
    { id: "grok-4", name: "Grok 4" },
    { id: "grok-code-fast-1", name: "Grok Code Fast" },
  ],
};

/** One frozen empty list, so an unknown provider keeps a stable identity. */
const NONE: Model[] = [];

export function modelsFor(providerId: string): Model[] {
  return MODELS[providerId] ?? NONE;
}

export function defaultModelFor(providerId: string): string {
  return MODELS[providerId]?.[0]?.id ?? "";
}

/** Falls back to the raw slug, which is the honest name for an unlisted model. */
export function modelNameFor(providerId: string, modelId: string): string {
  return (
    modelsFor(providerId).find((model) => model.id === modelId)?.name ?? modelId
  );
}

/** "grok-code-fast-1" -> "Grok Code Fast 1", for listings that answer with only an id. */
export function humanize(id: string): string {
  const last = id.split("/").pop() ?? id;

  return last
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
