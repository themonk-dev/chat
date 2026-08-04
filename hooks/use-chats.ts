"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  deleteChat,
  getChatsSnapshot,
  getServerChatsSnapshot,
  subscribeToChats,
} from "@/lib/chats/store";

/**
 * Subscribes to the store so there is one authority and every reader re-derives
 * together — a `useState` copy taken on mount missed the first saved thread.
 */
export function useChats() {
  const chats = useSyncExternalStore(
    subscribeToChats,
    getChatsSnapshot,
    getServerChatsSnapshot
  );

  const remove = useCallback((id: string) => {
    deleteChat(id);
  }, []);

  return { chats, remove };
}
