import type { ChatTransport, UIMessageChunk } from "ai";
import { convertToModelMessages, streamText } from "ai";
import { getWeather } from "@/lib/ai/tools/get-weather";
import type { ChatMessage } from "@/lib/types";
import { modelFor } from "./adapters";

type Resolve = () => {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * Runs the model call in the browser.
 *
 * The AI SDK's core is isomorphic, so `streamText` works here exactly as it does
 * on a server, and `toUIMessageStream()` produces precisely what `useChat`
 * expects to consume. From the hook's point of view nothing is unusual; the only
 * difference is that no request carrying a credential ever leaves for our
 * origin.
 */
export class OAuthChatTransport implements ChatTransport<ChatMessage> {
  readonly #resolve: Resolve;

  constructor(resolve: Resolve) {
    this.#resolve = resolve;
  }

  async sendMessages({
    messages,
  }: Parameters<ChatTransport<ChatMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const { accessToken, modelId, providerId } = this.#resolve();

    if (!accessToken) {
      throw new Error("Connect a provider before sending a message.");
    }

    // In the installed AI SDK version, `convertToModelMessages` is async
    // (it can resolve file/data parts), so it must be awaited before being
    // handed to `streamText`, which requires a plain `ModelMessage[]`.
    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      messages: modelMessages,
      model: modelFor(providerId, modelId, accessToken),
      tools: { getWeather },
    });

    return result.toUIMessageStream();
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    /*
     * There is no server-side stream to reconnect to — the request is made
     * from this tab, so a lost connection loses the generation with it.
     */
    return Promise.resolve(null);
  }
}
