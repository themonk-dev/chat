import { readUIMessageStream, type UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { attributionOf, type ChatMessage } from "@/lib/types";
import { readChat, writeChat } from "./store";

/**
 * Attribution has to be *on the message*, and it has to still be there after a
 * reload.
 *
 * Both halves matter separately. A value the transport knows but never attaches
 * to the message is invisible the moment the reply settles; a value attached but
 * not serialised is gone on the next page load, which for this app is the normal
 * case rather than an edge one — a thread lives in `localStorage` and nowhere
 * else.
 *
 * The message is built by driving the AI SDK's own stream reader with the chunks
 * the transport emits, rather than by hand-writing the message the SDK is
 * assumed to produce. That assumption is the thing worth testing: it is what
 * decides whether `messageMetadata` on a `start` chunk survives to
 * `message.metadata` at all.
 */

const chunks = (metadata?: unknown): UIMessageChunk[] => [
  {
    messageId: "assistant-1",
    ...(metadata ? { messageMetadata: metadata } : {}),
    type: "start",
  },
  { id: "t1", type: "text-start" },
  { delta: "42.", id: "t1", type: "text-delta" },
  { id: "t1", type: "text-end" },
  { type: "finish" },
];

async function assistantMessageFrom(
  metadata?: unknown
): Promise<ChatMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks(metadata)) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  let last: ChatMessage | undefined;

  for await (const message of readUIMessageStream<ChatMessage>({ stream })) {
    last = message;
  }

  return last;
}

describe("attribution on a stored assistant message", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("is carried on the message the stream produces", async () => {
    const message = await assistantMessageFrom({
      attribution: { modelId: "claude-sonnet-4-5", providerId: "claude" },
    });

    expect(attributionOf(message)).toEqual({
      modelId: "claude-sonnet-4-5",
      providerId: "claude",
    });
  });

  it("survives the round trip through localStorage", async () => {
    const message = await assistantMessageFrom({
      attribution: { modelId: "grok-4", providerId: "xai" },
    });

    writeChat({
      id: "chat-1",
      messages: [message as ChatMessage],
      title: "Which model answered?",
      updatedAt: 1,
    });

    const reloaded = readChat("chat-1")?.messages.at(0);

    expect(attributionOf(reloaded)).toEqual({
      modelId: "grok-4",
      providerId: "xai",
    });
  });

  /**
   * A chat written before this existed must keep working exactly as it did —
   * losing the history is far worse than missing a footnote — and must not
   * acquire an attribution it never had.
   */
  it("is absent, not guessed, for a chat stored before it existed", () => {
    const legacy = {
      id: "assistant-legacy",
      parts: [{ text: "Answered by somebody.", type: "text" }],
      role: "assistant",
    } as ChatMessage;

    writeChat({
      id: "chat-old",
      messages: [legacy],
      title: "Older thread",
      updatedAt: 1,
    });

    const reloaded = readChat("chat-old")?.messages.at(0);

    expect(reloaded?.parts).toHaveLength(1);
    expect(attributionOf(reloaded)).toBeUndefined();
  });

  /**
   * Storage is a text file a reader can edit, and a half-written pair would
   * otherwise reach the renderer as a model with no provider (or the reverse).
   */
  it("is absent for a stored pair that lost half of itself", () => {
    const damaged = {
      id: "assistant-damaged",
      metadata: { attribution: { providerId: "claude" } },
      parts: [{ text: "Hello.", type: "text" }],
      role: "assistant",
    } as unknown as ChatMessage;

    writeChat({
      id: "chat-damaged",
      messages: [damaged],
      title: "Damaged",
      updatedAt: 1,
    });

    expect(
      attributionOf(readChat("chat-damaged")?.messages.at(0))
    ).toBeUndefined();
  });
});
