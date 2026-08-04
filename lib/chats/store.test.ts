import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteChat,
  getChatsSnapshot,
  listChats,
  readChat,
  renameChat,
  subscribeToChats,
  writeChat,
} from "./store";

const message = (text: string) => ({
  id: `m-${text}`,
  parts: [{ text, type: "text" as const }],
  role: "user" as const,
});

describe("chat store", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("returns nothing when empty", () => {
    expect(listChats()).toEqual([]);
  });

  it("round-trips a chat", () => {
    writeChat({
      id: "a",
      messages: [message("hello")],
      title: "First",
      updatedAt: 1,
    });
    expect(readChat("a")?.title).toBe("First");
    expect(readChat("a")?.messages).toHaveLength(1);
  });

  it("lists most recently updated first", () => {
    writeChat({ id: "a", messages: [], title: "A", updatedAt: 1 });
    writeChat({ id: "b", messages: [], title: "B", updatedAt: 2 });
    expect(listChats().map((chat) => chat.id)).toEqual(["b", "a"]);
  });

  it("renames without touching messages", () => {
    writeChat({ id: "a", messages: [message("x")], title: "A", updatedAt: 1 });
    renameChat("a", "Renamed");
    expect(readChat("a")?.title).toBe("Renamed");
    expect(readChat("a")?.messages).toHaveLength(1);
  });

  it("deletes", () => {
    writeChat({ id: "a", messages: [], title: "A", updatedAt: 1 });
    deleteChat("a");
    expect(readChat("a")).toBeUndefined();
    expect(listChats()).toEqual([]);
  });

  it("survives a corrupted entry rather than throwing", () => {
    globalThis.localStorage.setItem("ai-oauth-chat:index", "{not json");
    expect(listChats()).toEqual([]);
  });

  it("swallows a write failure instead of throwing", () => {
    const setItemSpy = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    expect(() =>
      writeChat({ id: "a", messages: [], title: "A", updatedAt: 1 })
    ).not.toThrow();

    setItemSpy.mockRestore();
  });
});

/*
 * The sidebar showed a new chat only after a reload: every reader held its own
 * copy of a list taken before the save, and `localStorage` fires no event for a
 * write from the same document. These pin the announcement that fixed it.
 */
describe("chat store subscriptions", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    // Drain the cache left by other tests in this file.
    getChatsSnapshot();
  });

  it("tells subscribers when a chat is written", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToChats(listener);

    writeChat({
      id: "new",
      messages: [message("first")],
      title: "Fresh",
      updatedAt: 1,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("hands back a new snapshot after a write and the same one before", () => {
    const before = getChatsSnapshot();

    expect(getChatsSnapshot()).toBe(before);

    writeChat({
      id: "next",
      messages: [message("second")],
      title: "Later",
      updatedAt: 2,
    });

    const after = getChatsSnapshot();

    // Identity must change, or useSyncExternalStore never re-renders.
    expect(after).not.toBe(before);
    expect(after.map((chat) => chat.id)).toContain("next");
  });

  it("stops calling a listener once it unsubscribes", () => {
    const listener = vi.fn();

    subscribeToChats(listener)();
    writeChat({
      id: "ignored",
      messages: [message("third")],
      title: "Gone",
      updatedAt: 3,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("notices a delete as well as a write", () => {
    writeChat({
      id: "doomed",
      messages: [message("fourth")],
      title: "Doomed",
      updatedAt: 4,
    });

    const before = getChatsSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeToChats(listener);

    deleteChat("doomed");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getChatsSnapshot()).not.toBe(before);
    unsubscribe();
  });
});
