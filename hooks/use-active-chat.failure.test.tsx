import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failureMessage, isBlankReply } from "@/lib/chats/failure-message";
import { readChat } from "@/lib/chats/store";
import type { ChatMessage } from "@/lib/types";
import { ActiveChatProvider, useActiveChat } from "./use-active-chat";
import { shouldPersistChat } from "./use-persist-chat";

/**
 * A send that fails has to leave something behind.
 *
 * The live report: a Gemini send was refused for quota, retried three times
 * and gave up. On screen there was the reader's own message, no reply, no
 * explanation — and a toast that removed itself after a few seconds. Reloading
 * did not help, because nothing had been written to `localStorage` for that
 * chat id at all: the URL said `/chat/<id>` and there was no such chat. The
 * failure was not merely unexplained, it was unrecorded.
 *
 * These cover the two halves of the answer: the failure becomes a message in
 * the thread, and the thread with that message in it is stored like any other.
 */

const stored = new Map<string, string>();

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: (id: string) => ({
    getTokens: () => {
      const accessToken = stored.get(id);
      return Promise.resolve(
        accessToken ? { accessToken, provider: id } : undefined
      );
    },
    logout: () => {
      stored.delete(id);
      return Promise.resolve();
    },
  }),
}));

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => ({
    activeId: "openrouter",
    setActiveId: () => undefined,
    tokens: { accessToken: "openrouter-secret", provider: "openrouter" },
  }),
}));

/** The resolver it would be handed is exercised by the transport test. */
vi.mock("@/lib/oauth/transport", () => ({ OAuthChatTransport: class {} }));

vi.mock("next/navigation", () => ({ usePathname: () => "/chat/chat-1" }));

vi.mock("@/components/chat/data-stream-provider", () => ({
  useDataStream: () => ({
    setDataStream: () => undefined,
    setWaitingStatus: () => undefined,
  }),
}));

const toasted: string[] = [];
vi.mock("@/components/chat/toast", () => ({
  toast: ({ description }: { description: string }) => {
    toasted.push(description);
  },
}));

/** A real store, so "does a reload find it" is a question about real bytes. */
vi.mock("@/lib/chats/store", async (importOriginal) =>
  importOriginal<typeof import("@/lib/chats/store")>()
);

/**
 * `useChat`, reduced to the parts a failure travels through: the `onError`
 * the SDK calls (from a thrown send *and* from an `{type: "error"}` stream
 * chunk, which `Chat.makeRequest` rethrows into the same `catch`), and a
 * `setMessages` that keeps a transcript the way the real one does.
 */
let onError: ((error: Error) => void) | undefined;
let messages: ChatMessage[] = [];
let status = "ready";

vi.mock("@ai-sdk/react", () => ({
  useChat: ({ onError: reportError }: { onError: (error: Error) => void }) => {
    onError = reportError;

    return {
      addToolApprovalResponse: () => undefined,
      messages,
      regenerate: () => undefined,
      sendMessage: () => undefined,
      setMessages: (
        update: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])
      ) => {
        messages = typeof update === "function" ? update(messages) : update;
      },
      status,
      stop: () => undefined,
    };
  },
}));

const userMessage: ChatMessage = {
  id: "user-1",
  parts: [{ text: "Reply with exactly: ok", type: "text" }],
  role: "user",
};

/** The live failure, in the shape the SDK actually delivered it. */
function quotaFailure(): Error {
  return Object.assign(new Error("No output generated."), {
    cause: Object.assign(new Error("Failed after 3 attempts"), {
      lastError: Object.assign(
        new Error("You have exhausted your capacity on this model"),
        { name: "AI_APICallError" }
      ),
      name: "AI_RetryError",
    }),
    name: "AI_NoOutputGeneratedError",
  });
}

let chat: ReturnType<typeof useActiveChat> | undefined;

function Probe() {
  chat = useActiveChat();
  return null;
}

const tree = () => (
  <ActiveChatProvider>
    <Probe />
  </ActiveChatProvider>
);

function errorPart(message: ChatMessage | undefined) {
  return message?.parts.find((part) => part.type === "data-error");
}

describe("a send that fails", () => {
  beforeEach(() => {
    stored.clear();
    stored.set("openrouter", "openrouter-secret");
    messages = [userMessage];
    status = "ready";
    chat = undefined;
    onError = undefined;
    toasted.length = 0;
    localStorage.clear();
  });

  it("reports itself in the thread, as a message from the assistant", async () => {
    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      chat?.setCurrentModelId("anthropic/claude-sonnet-4.5", "openrouter");
    });

    act(() => {
      onError?.(quotaFailure());
    });

    const reported = messages.at(-1);

    expect(reported?.role).toBe("assistant");
    expect(errorPart(reported)).toBeDefined();
  });

  /**
   * The raw `AI_APICallError: You have exhausted your capacity on this model`
   * is good information badly packaged, not information to be thrown away: it
   * names the one thing the reader can do something about (pick another
   * model). The provider and model it applies to have to be named too — with
   * seven providers connectable at once, "a request failed" does not identify
   * which one.
   */
  it("names the provider, the model, and what the provider actually said", async () => {
    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      chat?.setCurrentModelId("anthropic/claude-sonnet-4.5", "openrouter");
    });

    act(() => {
      onError?.(quotaFailure());
    });

    expect(errorPart(messages.at(-1))).toMatchObject({
      data: {
        detail: "You have exhausted your capacity on this model",
        kind: "AI_APICallError",
        modelId: "anthropic/claude-sonnet-4.5",
        modelName: "Claude Sonnet 4.5",
        providerId: "openrouter",
        providerLabel: "OpenRouter",
      },
      type: "data-error",
    });
  });

  /**
   * A failure is attributed like any other assistant message.
   *
   * It is rendered from its own part rather than from this metadata — the block
   * already says which model didn't reply — but the message still carries it, so
   * every assistant message in a stored thread answers the same question the
   * same way, and a later reader of the transcript does not have to know that
   * failures are special.
   */
  it("carries the same attribution a successful reply would", async () => {
    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      chat?.setCurrentModelId("anthropic/claude-sonnet-4.5", "openrouter");
    });

    act(() => {
      onError?.(quotaFailure());
    });

    expect(messages.at(-1)?.metadata).toMatchObject({
      attribution: {
        modelId: "anthropic/claude-sonnet-4.5",
        providerId: "openrouter",
      },
    });
  });

  /** Retry has to re-send the reader's message, so it has to know which one. */
  it("points its retry at the user message that failed", async () => {
    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      onError?.(quotaFailure());
    });

    expect(errorPart(messages.at(-1))).toMatchObject({
      data: { retryOf: "user-1" },
    });
  });

  /** The toast may stay, but it is no longer the only thing that happens. */
  it("still says so immediately, as well as durably", async () => {
    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      onError?.(quotaFailure());
    });

    expect(toasted).toContain("You have exhausted your capacity on this model");
  });

  /**
   * The reload half. `usePersistChat` only wrote at `status === "ready"`, and
   * a failed send never reaches it — so the whole exchange, question included,
   * was missing from `localStorage` afterwards. Nothing is in flight in the
   * `"error"` state either, which is the only thing the gate was ever there to
   * exclude.
   */
  it("is stored, so a reload still shows the question and the reason", async () => {
    status = "error";
    messages = [
      userMessage,
      failureMessage({
        error: quotaFailure(),
        messages: [userMessage],
        modelId: "anthropic/claude-sonnet-4.5",
        providerId: "openrouter",
      }),
    ];

    render(tree());

    await waitFor(() => {
      expect(readChat("chat-1")?.messages).toHaveLength(2);
    });

    const reloaded = readChat("chat-1")?.messages;

    expect(reloaded?.[0].parts).toEqual(userMessage.parts);
    expect(errorPart(reloaded?.[1])).toMatchObject({
      data: { detail: "You have exhausted your capacity on this model" },
    });
  });

  it("treats an errored transcript as settled, the same as a finished one", () => {
    const settled = [userMessage];

    expect(
      shouldPersistChat({
        messages: settled,
        status: "error",
        storedMessages: [],
      })
    ).toBe(true);
    expect(
      shouldPersistChat({
        messages: settled,
        status: "streaming",
        storedMessages: [],
      })
    ).toBe(false);
  });
});

/**
 * One question, one reply — even when the reply is a failure.
 *
 * The live report: every error produced *two* assistant bubbles, an empty one
 * above the report. The SDK opens an assistant message the moment a send
 * starts, so by the time the failure arrives there is already a bubble on
 * screen holding nothing; appending the report left the carcass sitting above
 * it. `isBlankReply` is what decides whether that carcass is replaced or a
 * partial answer is kept.
 */
describe("isBlankReply", () => {
  const assistant = (parts: ChatMessage["parts"]): ChatMessage => ({
    id: "a1",
    parts,
    role: "assistant",
  });

  it("calls a freshly opened reply blank", () => {
    expect(isBlankReply(assistant([]))).toBe(true);
    expect(isBlankReply(assistant([{ type: "step-start" }]))).toBe(true);
  });

  it("calls an empty text part blank, whitespace included", () => {
    expect(isBlankReply(assistant([{ text: "", type: "text" }]))).toBe(true);
    expect(isBlankReply(assistant([{ text: "   \n", type: "text" }]))).toBe(
      true
    );
  });

  it("never discards a reply that said something", () => {
    expect(
      isBlankReply(assistant([{ text: "Half an ans", type: "text" }]))
    ).toBe(false);
  });

  it("never discards a reply that reasoned or called a tool", () => {
    expect(
      isBlankReply(assistant([{ text: "thinking", type: "reasoning" }]))
    ).toBe(false);
  });

  it("leaves the user's own message alone", () => {
    expect(
      isBlankReply({ id: "u1", parts: [], role: "user" } as ChatMessage)
    ).toBe(false);
  });

  it("has nothing to replace when the thread is empty", () => {
    expect(isBlankReply(undefined)).toBe(false);
  });
});
