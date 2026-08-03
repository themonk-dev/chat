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
});
