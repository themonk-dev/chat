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
