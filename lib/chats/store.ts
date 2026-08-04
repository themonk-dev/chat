import type { ChatMessage } from "@/lib/types";

export type StoredChat = {
  id: string;
  messages: ChatMessage[];
  title: string;
  updatedAt: number;
};

/**
 * Chats live in `localStorage` and nowhere else. There is no account here and
 * no server that could hold them — which is the point, and is why the sidebar
 * is the only index that exists.
 *
 * Deliberately not keyed by provider. A thread records what was said, not who
 * said it, so reopening one continues it with whatever provider is connected at
 * the time.
 */
const KEY = "ai-oauth-chat:index";

/*
 * `localStorage` fires no event for writes from the same document, so readers
 * cannot learn about a save on their own. The store therefore announces its own
 * writes, and it does so from `write` rather than from each mutation — one
 * place, which a new mutation cannot forget to call.
 *
 * The snapshot is a cached array rather than a counter. `useSyncExternalStore`
 * compares snapshots by identity, so it must be the *same* array until storage
 * actually moves — building a fresh one per call would re-render forever.
 */
const listeners = new Set<() => void>();
let cached: StoredChat[] | undefined;

/** One frozen empty list, so the server snapshot is identity-stable too. */
const EMPTY: StoredChat[] = [];

export function subscribeToChats(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getChatsSnapshot(): StoredChat[] {
  if (!cached) {
    cached = listChats();
  }

  return cached;
}

/** There is no storage during the server render, and nothing to describe. */
export function getServerChatsSnapshot(): StoredChat[] {
  return EMPTY;
}

export function listChats(): StoredChat[] {
  return [...read().values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readChat(id: string): StoredChat | undefined {
  return read().get(id);
}

export function writeChat(chat: StoredChat): void {
  const chats = read();
  chats.set(chat.id, chat);
  write(chats);
}

export function renameChat(id: string, title: string): void {
  const chats = read();
  const chat = chats.get(id);

  if (!chat) {
    return;
  }

  chats.set(id, { ...chat, title });
  write(chats);
}

export function deleteChat(id: string): void {
  const chats = read();
  chats.delete(id);
  write(chats);
}

/**
 * A corrupted or half-written store is answered with an empty one rather than
 * an exception. Losing the history is bad; a chat app that will not start
 * because of it is worse, and the next write repairs the file.
 */
function read(): Map<string, StoredChat> {
  if (typeof localStorage === "undefined") {
    return new Map();
  }

  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(
      (parsed as StoredChat[])
        .filter((chat) => typeof chat?.id === "string")
        .map((chat) => [chat.id, chat])
    );
  } catch {
    return new Map();
  }
}

function write(chats: Map<string, StoredChat>): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(KEY, JSON.stringify([...chats.values()]));
    cached = undefined;

    for (const listener of listeners) {
      listener();
    }
  } catch {
    /*
     * Quota exhausted, or storage disabled by the browser. The conversation on
     * screen is unaffected; only its persistence is lost, and telling the
     * reader mid-sentence would be worse than dropping it silently.
     */
  }
}
