import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteChat, readChat, writeChat } from "@/lib/chats/store";
import type { ChatMessage } from "@/lib/types";
import { shouldPersistChat, usePersistChat } from "./use-persist-chat";

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

/**
 * The `getWeather` approval request as `useChat` holds it while the Allow /
 * Deny buttons are on screen.
 */
const approvalRequested = (id: string): ChatMessage =>
  ({
    id,
    parts: [
      {
        approval: { id: "approval-1" },
        input: { city: "San Francisco" },
        state: "approval-requested",
        toolCallId: "call-1",
        type: "tool-getWeather",
      },
    ],
    role: "assistant",
  }) as unknown as ChatMessage;

/**
 * The same message after Deny. `addToolApprovalResponse` rewrites the last
 * message's `parts` via `replaceMessage(messages.length - 1, ...)`: the
 * message id, the array length and the `toolCallId` all survive untouched —
 * only the part's `state` and `approval` change.
 */
const approvalDenied = (id: string): ChatMessage =>
  ({
    id,
    parts: [
      {
        approval: {
          approved: false,
          id: "approval-1",
          reason: "User denied weather lookup",
        },
        input: { city: "San Francisco" },
        state: "approval-responded",
        toolCallId: "call-1",
        type: "tool-getWeather",
      },
    ],
    role: "assistant",
  }) as unknown as ChatMessage;

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

  it("persists a tool denial, which changes only a message's parts", () => {
    // Same ids, same count, same order — neither a count nor an id
    // signature can see this. Only the part's state and approval changed.
    const stored = [userMessage("u1", "weather?"), approvalRequested("a1")];
    const messages = [userMessage("u1", "weather?"), approvalDenied("a1")];

    expect(
      shouldPersistChat({ messages, status: "ready", storedMessages: stored })
    ).toBe(true);
  });

  it("persists an in-place text edit that keeps every id", () => {
    // The general form of the same hole: content changed, structure did not.
    const stored = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    const messages = [
      userMessage("u1", "hi"),
      assistantMessage("a1", "hello, corrected"),
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

  /**
   * The round-3 hole, driven end to end. The approval request settles to
   * "ready" and is persisted; pressing Deny then rewrites that same message's
   * parts in place — `addToolApprovalResponse` calls
   * `replaceMessage(messages.length - 1, { ...lastMessage, parts })`, so the
   * id sequence and the count are byte-identical to what was just stored, and
   * `sendAutomaticallyWhen` does not fire on a denial, so nothing further
   * changes the transcript. An id or count signature skips the write and the
   * denial is lost on reload.
   */
  it("persists a denied tool approval, whose ids and count never change", () => {
    const request = [userMessage("u1", "weather?"), approvalRequested("a1")];
    writeChat({
      id: chatId,
      messages: request as ChatMessage[],
      title: "weather?",
      updatedAt: 1,
    });

    const { rerender } = renderHook(
      (props: { messages: ChatMessage[]; status: string }) =>
        usePersistChat({
          chatId,
          messages: props.messages,
          status: props.status,
        }),
      { initialProps: { messages: request as ChatMessage[], status: "ready" } }
    );

    // Re-opening the settled approval request re-stamps nothing.
    expect(readChat(chatId)?.updatedAt).toBe(1);

    // Deny: same ids, same length, new parts.
    const denied = [userMessage("u1", "weather?"), approvalDenied("a1")];
    expect(denied.map((m) => m.id)).toEqual(request.map((m) => m.id));
    expect(denied).toHaveLength(request.length);

    rerender({ messages: denied, status: "ready" });

    const persisted = readChat(chatId)?.messages as ChatMessage[] | undefined;
    expect(persisted).toEqual(denied);
    expect(
      (persisted?.[1].parts[0] as { state?: string } | undefined)?.state
    ).toBe("approval-responded");
    expect(readChat(chatId)?.updatedAt).not.toBe(1);
  });
});
