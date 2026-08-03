import { describe, expect, it } from "vitest";
import { shouldPersistChat } from "./use-active-chat";

describe("shouldPersistChat", () => {
  it("does not persist merely opening a stored thread", () => {
    // Loading a thread hands useChat a non-empty messages array and a
    // "ready" status right away — the count matches what was already
    // persisted, so this must not count as new activity.
    expect(
      shouldPersistChat({
        lastPersistedCount: 5,
        messageCount: 5,
        status: "ready",
      })
    ).toBe(false);
  });

  it("does not persist an empty thread", () => {
    expect(
      shouldPersistChat({
        lastPersistedCount: 0,
        messageCount: 0,
        status: "ready",
      })
    ).toBe(false);
  });

  it("does not persist while a reply is still streaming", () => {
    expect(
      shouldPersistChat({
        lastPersistedCount: 2,
        messageCount: 4,
        status: "submitted",
      })
    ).toBe(false);
  });

  it("persists once a message count actually grows and settles", () => {
    expect(
      shouldPersistChat({
        lastPersistedCount: 2,
        messageCount: 4,
        status: "ready",
      })
    ).toBe(true);
  });

  it("persists the very first message of a brand new thread", () => {
    expect(
      shouldPersistChat({
        lastPersistedCount: 0,
        messageCount: 2,
        status: "ready",
      })
    ).toBe(true);
  });
});
