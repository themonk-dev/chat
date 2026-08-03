import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteChat, readChat, writeChat } from "@/lib/chats/store";
import { shouldPersistChat, usePersistChat } from "./use-active-chat";

const userMessage = (id: string, text: string) => ({
  id,
  parts: [{ text, type: "text" as const }],
  role: "user" as const,
});

const assistantMessage = (id: string, text: string) => ({
  id,
  parts: [{ text, type: "text" as const }],
  role: "assistant" as const,
});

describe("shouldPersistChat", () => {
  it("does not persist merely opening a stored thread", () => {
    // Loading a thread hands useChat a non-empty messages array and a
    // "ready" status right away — the ids match what was already stored,
    // so this must not count as new activity.
    const messages = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    expect(
      shouldPersistChat({ messages, status: "ready", storedMessages: messages })
    ).toBe(false);
  });

  it("does not persist an empty thread", () => {
    expect(
      shouldPersistChat({ messages: [], status: "ready", storedMessages: [] })
    ).toBe(false);
  });

  it("does not persist while a reply is still streaming", () => {
    const stored = [userMessage("u1", "hi")];
    const messages = [...stored, assistantMessage("a1", "partial")];
    expect(
      shouldPersistChat({
        messages,
        status: "submitted",
        storedMessages: stored,
      })
    ).toBe(false);
  });

  it("persists once a reply completes and the transcript actually changed", () => {
    const stored = [userMessage("u1", "hi")];
    const messages = [...stored, assistantMessage("a1", "hello")];
    expect(
      shouldPersistChat({ messages, status: "ready", storedMessages: stored })
    ).toBe(true);
  });

  it("persists the very first message of a brand new thread", () => {
    const messages = [userMessage("u1", "hi")];
    expect(
      shouldPersistChat({ messages, status: "ready", storedMessages: [] })
    ).toBe(true);
  });

  it("persists a same-length transcript whose ids differ from what is stored", () => {
    // A count comparison alone cannot distinguish this from "nothing
    // changed" — this is exactly the shape of the clear-then-send and
    // edit-and-regenerate bugs a count-based guard missed twice.
    const stored = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    const messages = [
      userMessage("u2", "different"),
      assistantMessage("a2", "new"),
    ];
    expect(
      shouldPersistChat({ messages, status: "ready", storedMessages: stored })
    ).toBe(true);
  });
});

describe("usePersistChat", () => {
  const chatId = "chat-1";

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("does not re-stamp a thread that was merely opened", () => {
    const messages = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    writeChat({ id: chatId, messages, title: "Existing", updatedAt: 1 });

    renderHook(() => usePersistChat({ chatId, messages, status: "ready" }));

    expect(readChat(chatId)?.updatedAt).toBe(1);
  });

  /**
   * This is the round-2 bug, reproduced end to end through the real hook
   * rather than hand-picked literals: a thread is cleared, then a new
   * exchange happens to land back on the same message count as before the
   * clear. A count-based guard (the old lastPersistedCountRef) would see
   * "2 then 2" and wrongly skip the write. Deleting this guard, or
   * reverting to a count comparison, fails this test.
   */
  it("persists a post-clear exchange even when it lands on the same message count", () => {
    const original = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    writeChat({
      id: chatId,
      messages: original,
      title: "Original",
      updatedAt: 1,
    });

    const { rerender } = renderHook(
      (props: { messages: typeof original; status: string }) =>
        usePersistChat({
          chatId,
          messages: props.messages,
          status: props.status,
        }),
      { initialProps: { messages: original, status: "ready" } }
    );

    // clearChat(): empty the messages and delete the store entry.
    deleteChat(chatId);
    rerender({ messages: [], status: "ready" });
    expect(readChat(chatId)).toBeUndefined();

    // A new exchange lands back on a count of 2 — the same as before the
    // clear — but with entirely different content and ids.
    const replacement = [
      userMessage("u2", "new question"),
      assistantMessage("a2", "new reply"),
    ];
    rerender({ messages: replacement, status: "ready" });

    expect(readChat(chatId)?.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  /**
   * The second instance of the same bug class: message-editor.tsx's
   * submitEditedMessage truncates messages and calls regenerate(), which
   * can also land back on the pre-edit message count without touching
   * chatId. No ref to reset here — the fix has to hold without any
   * edit-specific handling at all.
   */
  it("persists an edited-and-regenerated exchange even when the count returns to its starting value", () => {
    const original = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    writeChat({
      id: chatId,
      messages: original,
      title: "Original",
      updatedAt: 1,
    });

    const { rerender } = renderHook(
      (props: { messages: typeof original; status: string }) =>
        usePersistChat({
          chatId,
          messages: props.messages,
          status: props.status,
        }),
      { initialProps: { messages: original, status: "ready" } }
    );

    // submitEditedMessage(): the edited user message keeps its id (u1) but
    // its text changes, and regenerate() replaces the assistant reply with
    // a brand new one (a2) — same count, different content.
    const edited = [
      userMessage("u1", "hi, edited"),
      assistantMessage("a2", "new reply"),
    ];
    rerender({ messages: edited, status: "ready" });

    expect(readChat(chatId)?.messages).toEqual(edited);
    expect(readChat(chatId)?.updatedAt).not.toBe(1);
  });
});
