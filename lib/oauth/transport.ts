import type { ChatTransport, UIMessageChunk } from "ai";
import { convertToModelMessages, streamText } from "ai";
import { getWeather } from "@/lib/ai/tools/get-weather";
import type { ChatMessage } from "@/lib/types";
import { CLAUDE_SYSTEM, modelFor } from "./adapters";
import { streamGemini } from "./gemini-stream";
import { registry } from "./registry";
import { attributionMetadata, streamErrorText } from "./stream-metadata";

type Resolve = () => {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * Claude's prompt must travel as `instructions`; the SDK rejects a `system`
 * message outright. Codex needs `store: false` or it answers with a silent
 * empty stream.
 */
function providerCallOptions(providerId: string) {
  if (providerId === "claude") {
    return { instructions: CLAUDE_SYSTEM };
  }

  if (providerId === "openai") {
    return { providerOptions: { openai: { store: false } } };
  }

  return {};
}

/**
 * Runs the model call in the browser. The AI SDK's core is isomorphic, so
 * `useChat` sees nothing unusual — only that no credentialed request ever
 * leaves for our own origin.
 */
export class OAuthChatTransport implements ChatTransport<ChatMessage> {
  readonly #resolve: Resolve;

  constructor(resolve: Resolve) {
    this.#resolve = resolve;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<ChatMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const { accessToken, modelId, providerId } = this.#resolve();

    // Named, not generic: `providerId` is the model's owner, so it is exactly
    // the provider they have to sign into, even with others already connected.
    if (!accessToken) {
      const label = registry[providerId]?.label ?? providerId;

      throw new Error(`Connect ${label} before sending this model's messages.`);
    }

    // Async in this SDK version — it can resolve file/data parts.
    const modelMessages = await convertToModelMessages(messages);

    if (providerId === "gemini") {
      return streamGemini({ abortSignal, accessToken, modelId, modelMessages });
    }

    const model = await modelFor(providerId, modelId, accessToken);

    // `abortSignal` is what `useChat`'s `stop()` aborts; without it Stop only
    // stops the UI while the request runs on.
    const result = streamText({
      abortSignal,
      ...providerCallOptions(providerId),
      messages: modelMessages,
      model,
      tools: { getWeather },
    });

    return result.toUIMessageStream({
      messageMetadata: attributionMetadata({ modelId, providerId }),
      onError: streamErrorText,
    });
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // The request is made from this tab, so a lost connection loses the
    // generation with it — there is no server-side stream to resume.
    return Promise.resolve(null);
  }
}
