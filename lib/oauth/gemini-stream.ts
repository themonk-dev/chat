import type { ModelMessage, UIMessageChunk } from "ai";
import { streamText } from "ai";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { modelFor } from "./adapters";
import { attributionMetadata, streamErrorText } from "./stream-metadata";

type GeminiStreamOptions = {
  abortSignal: AbortSignal | undefined;
  accessToken: string;
  modelId: string;
  modelMessages: ModelMessage[];
};

async function forwardTo(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  source: ReadableStream<UIMessageChunk>
): Promise<void> {
  const reader = source.getReader();

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: draining a reader is inherently sequential
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    controller.enqueue(value);
  }
}

/**
 * Gemini cannot build a model until its Code Assist project id is resolved,
 * which on a first sign-in means up to twenty seconds of polling. Returning the
 * stream first and reporting progress on it keeps that from reading as a hang.
 */
export function streamGemini({
  abortSignal,
  accessToken,
  modelId,
  modelMessages,
}: GeminiStreamOptions): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        const model = await modelFor(
          "gemini",
          modelId,
          accessToken,
          (message) => {
            controller.enqueue({
              data: { message, modelId, modelName: modelId, phase: "thinking" },
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

        await forwardTo(
          controller,
          result.toUIMessageStream({
            messageMetadata: attributionMetadata({
              modelId,
              providerId: "gemini",
            }),
            onError: streamErrorText,
          })
        );

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
