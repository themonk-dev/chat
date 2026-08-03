"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteChat, listChats, type StoredChat } from "@/lib/chats/store";

/**
 * The sidebar's data source. `localStorage` has no change events for writes
 * from the same document, so the refresh is explicit — the chat provider calls
 * it when a thread is saved.
 */
export function useChats() {
  const [chats, setChats] = useState<StoredChat[]>([]);

  const refresh = useCallback(() => {
    setChats(listChats());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(
    (id: string) => {
      deleteChat(id);
      refresh();
    },
    [refresh]
  );

  return { chats, refresh, remove };
}
