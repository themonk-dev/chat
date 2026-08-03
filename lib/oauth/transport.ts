import type { ChatTransport, ModelMessage, UIMessageChunk } from "ai";
import { convertToModelMessages, streamText } from "ai";
import { getWeather } from "@/lib/ai/tools/get-weather";
import type { ChatMessage } from "@/lib/types";
import { CLAUDE_SYSTEM, modelFor } from "./adapters";

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
    abortSignal,
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

    // Gemini's model cannot be built at all until its Code Assist project id
    // is resolved, which on a first sign-in can take up to twenty seconds of
    // polling. Returning the stream immediately and reporting progress on it
    // — rather than waiting until setup finishes to return a stream at all —
    // is what keeps that wait from reading as a hang.
    if (providerId === "gemini") {
      return streamGemini({ abortSignal, accessToken, modelId, modelMessages });
    }

    const model = await modelFor(providerId, modelId, accessToken);

    // `abortSignal` is the signal `useChat`'s `stop()` aborts. Threading it
    // into `streamText` is what makes Stop actually cancel the in-flight
    // request instead of leaving it to finish in the background while the
    // UI ignores the rest of the stream.
    const result = streamText({
      abortSignal,
      messages:
        providerId === "claude"
          ? [{ content: CLAUDE_SYSTEM, role: "system" }, ...modelMessages]
          : modelMessages,
      model,
      // Codex runs stateless and answers a request that does not say so with
      // a silent empty stream. `adapters.ts` enforces this at the wire level
      // too (a fetch a provider option can't reach past), so this is belt
      // and suspenders — but it is what the SDK's own types expect to see.
      ...(providerId === "openai"
        ? { providerOptions: { openai: { store: false } } }
        : {}),
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

/**
 * Gemini's send path, kept separate from the one above.
 *
 * Every other provider builds its model and calls `streamText` before
 * `sendMessages` returns anything, so `useChat` never sees a stream until
 * there is real work in flight. Gemini can't follow that shape without an
 * up-to-twenty-second silence first, so this constructs the returned stream
 * up front and does the setup work — and reports on it — from inside it.
 */
function streamGemini({
  abortSignal,
  accessToken,
  modelId,
  modelMessages,
}: {
  abortSignal: AbortSignal | undefined;
  accessToken: string;
  modelId: string;
  modelMessages: ModelMessage[];
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        const model = await modelFor(
          "gemini",
          modelId,
          accessToken,
          (message) => {
            controller.enqueue({
              data: {
                message,
                modelId,
                modelName: modelId,
                phase: "thinking",
              },
              transient: true,
              type: "data-waiting-status",
            });
          }
        );

        const result = streamText({
          abortSignal,
          messages: modelMessages,
          model,
          tools: { getWeather },
        });

        const reader = result.toUIMessageStream().getReader();

        for (;;) {
          // biome-ignore lint/performance/noAwaitInLoops: draining a reader is inherently sequential — each read depends on the last one's result
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          controller.enqueue(value);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
