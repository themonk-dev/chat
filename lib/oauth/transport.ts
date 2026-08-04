import type {
  ChatTransport,
  ModelMessage,
  TextStreamPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import { convertToModelMessages, streamText } from "ai";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { describeSendFailure, labelledFailureText } from "@/lib/errors";
import type {
  ChatMessage,
  MessageAttribution,
  MessageMetadata,
} from "@/lib/types";
import { CLAUDE_SYSTEM, modelFor } from "./adapters";
import { registry } from "./registry";

/**
 * What a mid-stream failure is allowed to say.
 *
 * `toUIMessageStream` defaults this to the constant "An error occurred." — the
 * right default on a server, where the alternative is leaking a stack trace to
 * a stranger. Here there is no server and no stranger: the model call is made
 * in the reader's own tab with the reader's own token, so the only person the
 * provider's message could be withheld from is the one it was written for.
 * Keeping the default here is how a quota rejection with a perfectly clear
 * explanation reaches the thread as five useless words.
 *
 * The class name is folded into the same string because a string is all the
 * SDK carries across a stream: the far end rebuilds this as a plain
 * `new Error(text)`, so anything not written here is lost. `describeSendFailure`
 * unfolds it again.
 */
const streamErrorText = (error: unknown): string =>
  labelledFailureText(describeSendFailure(error));

type Resolve = () => {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * Stamps the assistant message with who is producing it.
 *
 * This is the one place that already holds the *resolved* answer — the model's
 * owner, which `resolveRequest` derives and which is deliberately not whichever
 * provider happens to be active — so a stamp made here cannot describe a
 * different request than the one being made. Asking again later (at finish
 * time, or at render time) is how a reply comes to be credited to whoever the
 * reader has since switched to, which is the bug class this codebase keeps
 * meeting.
 *
 * On `start` rather than `finish`, and only there: `useChat` merges metadata
 * into the message as soon as the chunk arrives, so a reply that is stopped
 * halfway, or whose stream dies mid-sentence, is attributed just like one that
 * finished. Returning `undefined` for every other part keeps it to a single
 * stamp — `toUIMessageStream` emits a `message-metadata` chunk for any part
 * this answers.
 */
function attributionMetadata(
  attribution: MessageAttribution
): (options: { part: TextStreamPart<ToolSet> }) => MessageMetadata | undefined {
  return ({ part }) => (part.type === "start" ? { attribution } : undefined);
}

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

    /*
     * Named, not generic. The state that actually produces this is a
     * selection whose *owner* has no token — which the reader typically
     * reaches with one or more other providers still connected, so "connect
     * a provider" reads as a lie about a popover that says "2 connected".
     * `providerId` is the model's owner (see `resolveRequest`), so it is
     * exactly the provider they have to sign into for this send to work.
     */
    if (!accessToken) {
      const label = registry[providerId]?.label ?? providerId;

      throw new Error(`Connect ${label} before sending this model's messages.`);
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

    return result.toUIMessageStream({
      messageMetadata: attributionMetadata({ modelId, providerId }),
      onError: streamErrorText,
    });
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

        const reader = result
          .toUIMessageStream({
            messageMetadata: attributionMetadata({
              modelId,
              providerId: "gemini",
            }),
            onError: streamErrorText,
          })
          .getReader();

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
