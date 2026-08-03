import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Builds an AI SDK model for a provider, pointed at our own proxy.
 *
 * The token is supplied here, in the browser, and travels as an `Authorization`
 * header the proxy forwards without reading. This is what lets the playground
 * claim the credential never reaches a server of ours while still using stock
 * AI SDK adapters — and therefore tool calling, reasoning parts and structured
 * output — rather than a hand-rolled stream reader.
 */
export function modelFor(
  id: string,
  modelId: string,
  accessToken: string
): LanguageModel {
  if (id === "openrouter") {
    return createOpenRouter({
      apiKey: accessToken,
      baseURL: "/api/upstream/openrouter",
    }).chat(modelId);
  }

  throw new Error(`No adapter yet for provider: ${id}`);
}
