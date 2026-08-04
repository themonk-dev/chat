"use client";

import { useEffect } from "react";
import { readChat, writeChat } from "@/lib/chats/store";
import type { ChatMessage } from "@/lib/types";

/**
 * `"error"` belongs here as squarely as `"ready"`: nothing is streaming, and
 * leaving it out is why a failed exchange vanished on reload.
 */
const SETTLED_STATUSES = new Set(["ready", "error"]);

const TITLE_LENGTH = 60;

/**
 * Serialising is what `writeChat` does anyway, so equal signatures mean equal
 * stored bytes. Every cheaper comparison tried here has been a bug: a count
 * misses clear-then-send, an id sequence misses an in-place part rewrite.
 */
function transcriptSignature(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

export function shouldPersistChat({
  status,
  messages,
  storedMessages,
}: {
  status: string;
  messages: readonly unknown[];
  storedMessages: readonly unknown[];
}): boolean {
  if (!SETTLED_STATUSES.has(status) || messages.length === 0) {
    return false;
  }

  try {
    return (
      transcriptSignature(messages) !== transcriptSignature(storedMessages)
    );
  } catch {
    // A transcript that will not serialise would not survive `writeChat`
    // either; let its own guarded write be the single place that fails.
    return true;
  }
}

function titleOf(messages: readonly ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");

  const text = first?.parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .slice(0, TITLE_LENGTH);

  return text || "New chat";
}

export function usePersistChat({
  chatId,
  messages,
  status,
}: {
  chatId: string;
  messages: ChatMessage[];
  status: string;
}): void {
  useEffect(() => {
    // Checked before storage is touched: reading the store parses the whole
    // index out of `localStorage`.
    if (!SETTLED_STATUSES.has(status) || messages.length === 0) {
      return;
    }

    const storedMessages = readChat(chatId)?.messages ?? [];

    if (!shouldPersistChat({ messages, status, storedMessages })) {
      return;
    }

    writeChat({
      id: chatId,
      messages,
      title: titleOf(messages),
      updatedAt: Date.now(),
    });
  }, [chatId, messages, status]);
}
