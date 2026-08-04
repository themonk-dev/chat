import type { ChatMessage } from "@/lib/types";

export type StoredChat = {
  id: string;
  messages: ChatMessage[];
  title: string;
  updatedAt: number;
};

/**
 * Chats live in `localStorage` and nowhere else, and are deliberately not keyed
 * by provider: a thread records what was said, not who said it.
 */
const KEY = "ai-oauth-chat:index";

/*
 * `localStorage` fires no event for same-document writes, so the store
 * announces its own — from `write`, which no new mutation can forget to call.
 * The snapshot is cached because `useSyncExternalStore` compares by identity.
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

/** A corrupt store answers empty rather than throwing; the next write repairs it. */
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
    // Quota exhausted, or storage disabled. Only persistence is lost, and
    // saying so mid-sentence would be worse than dropping it silently.
  }
}
