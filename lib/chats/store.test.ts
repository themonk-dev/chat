import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteChat,
  listChats,
  readChat,
  renameChat,
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
