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
  } catch {
    /*
     * Quota exhausted, or storage disabled by the browser. The conversation on
     * screen is unaffected; only its persistence is lost, and telling the
     * reader mid-sentence would be worse than dropping it silently.
     */
  }
}
