"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  deleteChat,
  getChatsSnapshot,
  getServerChatsSnapshot,
  subscribeToChats,
} from "@/lib/chats/store";

/**
 * The sidebar's data source.
 *
 * This used to hold its own `useState` and read once on mount, with a `refresh`
 * its consumers were expected to call. Nothing called it on the path that
 * matters, so a chat created by sending the first message did not appear in the
 * sidebar until the page was reloaded — the thread was saved, but every reader
 * held an independent copy of a list taken before the save.
 *
 * Subscribing to the store instead means there is one authority — storage — and
 * every reader re-derives from it together. The same shape already fixed the
 * connection map in `use-active-chat`, for the same reason.
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

  /**
   * Kept so existing callers keep compiling. It is a no-op by design now: every
   * mutation goes through the store's own `write`, which invalidates the cache
   * and notifies, so there is nothing left for a caller to trigger by hand.
   */
  const refresh = useCallback(() => {
    // Intentionally empty — the subscription already covers every write.
  }, []);

  return { chats, refresh, remove };
}
