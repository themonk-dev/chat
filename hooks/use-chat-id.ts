"use client";

import { useMemo, useRef } from "react";
import { readChat } from "@/lib/chats/store";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);

  return match ? match[1] : null;
}

/** A fresh id whenever the reader lands back on `/`, kept in a ref because
 * replacing it must not schedule a render of its own. */
export function useChatIdForPath(pathname: string): {
  chatId: string;
  isNewChat: boolean;
} {
  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }

  prevPathnameRef.current = pathname;

  return { chatId: chatIdFromUrl ?? newChatIdRef.current, isNewChat };
}

/**
 * `readChat` parses the whole chat index out of `localStorage`, and `useChat`
 * only reads this on the render that establishes a chat id — so doing it per
 * render meant re-parsing every stored thread on every keystroke and chunk.
 */
export function useStoredMessages(chatId: string): ChatMessage[] {
  return useMemo(() => readChat(chatId)?.messages ?? [], [chatId]);
}
