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

  it("persists a post-clear exchange even if the count returns to its pre-clear value", () => {
    // A thread with 2 stored messages is cleared. clearChat() resets the
    // baseline to 0, matching what is actually stored: nothing. The user
    // then sends one message and gets one reply, landing back on a count
    // of 2 — the same number as before the clear, but genuinely new
    // content that must not be mistaken for "nothing changed".
    expect(
      shouldPersistChat({
        lastPersistedCount: 0,
        messageCount: 2,
        status: "ready",
      })
    ).toBe(true);
  });

  it("regression guard: a stale pre-clear baseline would wrongly skip that exchange", () => {
    // This is the bug clearChat() fixes: if the baseline were left at its
    // pre-clear value of 2 instead of being reset to 0, a post-clear
    // exchange that also nets 2 messages would be indistinguishable from
    // "nothing happened" and silently never persisted.
    expect(
      shouldPersistChat({
        lastPersistedCount: 2,
        messageCount: 2,
        status: "ready",
      })
    ).toBe(false);
  });
});
