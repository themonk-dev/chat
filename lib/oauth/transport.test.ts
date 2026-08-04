import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const convertToModelMessagesMock = vi.fn(async (...args: unknown[]) => args[0]);

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    convertToModelMessages: (...args: unknown[]) =>
      convertToModelMessagesMock(...args),
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

vi.mock("./adapters", () => ({
  modelFor: vi.fn(() => "fake-model"),
}));

vi.mock("@/lib/ai/tools/get-weather", () => ({
  getWeather: {},
}));

const { OAuthChatTransport } = await import("./transport");

/**
 * `useChat`'s `stop()` aborts an internal `AbortController` and hands its
 * signal to `sendMessages` as `abortSignal` — nothing else in the pipeline
 * (`consumeStream` reads the returned stream with no signal of its own)
 * observes it. If `sendMessages` does not forward that signal into
 * `streamText`, Stop only stops the UI from appending further chunks; the
 * in-flight request keeps running against the provider until it finishes on
 * its own. This is a regression test for exactly that: it asserts
 * `streamText` is called with the same `AbortSignal` instance `sendMessages`
 * received, without needing a live stream or network call (both `ai` and
 * `./adapters` are mocked above).
 */
describe("OAuthChatTransport", () => {
  it("forwards the abort signal from sendMessages into streamText", async () => {
    const toUIMessageStream = vi.fn(() => new ReadableStream<UIMessageChunk>());
    streamTextMock.mockReturnValue({ toUIMessageStream });

    const transport = new OAuthChatTransport(() => ({
      accessToken: "test-token",
      modelId: "test-model",
      providerId: "openrouter",
    }));

    const controller = new AbortController();

    await transport.sendMessages({
      abortSignal: controller.signal,
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      trigger: "submit-message",
    });

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  /**
   * The state that reaches this branch is a selection whose *owner* holds no
   * token — which a reader normally hits with other providers still
   * connected, so a generic "connect a provider" describes the wrong fact
   * about the app they are looking at. `providerId` is the owner
   * (`resolveRequest` derives it), so it is the one thing worth saying.
   */
  it("names the model's owner when that owner has no token", async () => {
    const transport = new OAuthChatTransport(() => ({
      accessToken: undefined,
      modelId: "claude-sonnet-4-5",
      providerId: "claude",
    }));

    await expect(
      transport.sendMessages({
        abortSignal: undefined,
        chatId: "chat-1",
        messageId: undefined,
        messages: [],
        trigger: "submit-message",
      })
    ).rejects.toThrow("Connect Claude before sending this model's messages.");
  });
});

/**
 * Which provider and model produced a reply is decided here and nowhere else.
 *
 * The transport is the one place that already holds the *resolved* answer —
 * `resolveRequest` hands it the model's owner, which is deliberately not
 * whichever provider happens to be active — so stamping the message from here
 * cannot drift from the request that was actually made. Reading the active
 * provider again at render time, or at finish time, is the recurring bug this
 * placement forecloses: by then it may name somebody else entirely.
 *
 * Stamped on the stream's `start` part rather than its `finish`, so a reply
 * that is stopped halfway, or that dies mid-stream, is still attributed.
 */
type MetadataFor = (options: { part: { type: string } }) => unknown;

/** Gemini's stream does its work while being read, so it has to be read. */
function drain(stream: ReadableStream<UIMessageChunk>): Promise<void> {
  return stream.pipeTo(new WritableStream());
}

describe("attribution on the reply", () => {
  it("stamps the provider and model that served the request", async () => {
    let options: { messageMetadata?: MetadataFor } | undefined;
    const toUIMessageStream = vi.fn(
      (received: { messageMetadata?: MetadataFor }) => {
        options = received;
        return new ReadableStream<UIMessageChunk>();
      }
    );
    streamTextMock.mockReturnValue({ toUIMessageStream });

    const transport = new OAuthChatTransport(() => ({
      accessToken: "test-token",
      modelId: "anthropic/claude-sonnet-4.5",
      providerId: "openrouter",
    }));

    await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      trigger: "submit-message",
    });

    expect(options?.messageMetadata?.({ part: { type: "start" } })).toEqual({
      attribution: {
        modelId: "anthropic/claude-sonnet-4.5",
        providerId: "openrouter",
      },
    });
  });

  /**
   * Gemini's send path builds its own stream so it can report setup progress,
   * which means it calls `toUIMessageStream` at a second site. A reply from the
   * one provider whose sign-in takes twenty seconds is not the one to leave
   * anonymous.
   */
  it("stamps Gemini's separately-built stream too", async () => {
    let options: { messageMetadata?: MetadataFor } | undefined;
    const toUIMessageStream = vi.fn(
      (received: { messageMetadata?: MetadataFor }) => {
        options = received;
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.close();
          },
        });
      }
    );
    streamTextMock.mockReturnValue({ toUIMessageStream });

    const transport = new OAuthChatTransport(() => ({
      accessToken: "test-token",
      modelId: "gemini-2.5-flash",
      providerId: "gemini",
    }));

    await drain(
      await transport.sendMessages({
        abortSignal: undefined,
        chatId: "chat-1",
        messageId: undefined,
        messages: [],
        trigger: "submit-message",
      })
    );

    expect(options?.messageMetadata?.({ part: { type: "start" } })).toEqual({
      attribution: { modelId: "gemini-2.5-flash", providerId: "gemini" },
    });
  });

  /** One stamp per message: the `finish` part must not re-announce it. */
  it("stamps the message once, at the start", async () => {
    let options: { messageMetadata?: MetadataFor } | undefined;
    const toUIMessageStream = vi.fn(
      (received: { messageMetadata?: MetadataFor }) => {
        options = received;
        return new ReadableStream<UIMessageChunk>();
      }
    );
    streamTextMock.mockReturnValue({ toUIMessageStream });

    const transport = new OAuthChatTransport(() => ({
      accessToken: "test-token",
      modelId: "grok-4",
      providerId: "xai",
    }));

    await transport.sendMessages({
      abortSignal: undefined,
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      trigger: "submit-message",
    });

    expect(
      options?.messageMetadata?.({ part: { type: "finish" } })
    ).toBeUndefined();
    expect(
      options?.messageMetadata?.({ part: { type: "text-delta" } })
    ).toBeUndefined();
  });
});
