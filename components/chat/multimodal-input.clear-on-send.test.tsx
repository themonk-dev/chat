import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MultimodalInput } from "./multimodal-input";

/**
 * The composer has to be empty once a message is on its way — in React state
 * and in the textarea the reader is looking at — and it has to stay empty.
 *
 * Live, it did neither reliably. The three clears sat *after* the
 * `sendMessage(...)` call, so emptying the box was contingent on that call
 * behaving; and the draft-restore effect preferred `textareaRef.current.value`
 * over React state, so any later write to the stored draft could push old text
 * back into a composer the reader had already emptied. Both failures show up
 * the same way to a reader: their sent text still in the box, under a live
 * Send button, which a second Enter sends again.
 *
 * Nothing that would answer the question is mocked away: `input` is real state
 * in a wrapper, `useLocalStorage` is the real one over jsdom's `localStorage`,
 * and submits go through `PromptInput`'s own (async) form handler. `StrictMode`
 * matches how Next runs this in development, where the report came from.
 */

vi.mock("@/hooks/use-active-chat", () => ({
  getSelectionProviderId: () => "openrouter",
}));

vi.mock("@/hooks/use-connected-providers", () => ({
  useConnectedProviders: () => new Map([["openrouter", "openrouter-secret"]]),
}));

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => ({
    activeId: "openrouter",
    setActiveId: () => undefined,
    tokens: { accessToken: "openrouter-secret" },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: () => undefined }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
  }),
}));

vi.mock("@/lib/chats/store", () => ({
  deleteChat: () => undefined,
  listChats: () => [],
  readChat: () => undefined,
  writeChat: () => undefined,
}));

vi.mock("@/lib/oauth/models", () => ({
  fetchModelsFor: () => Promise.resolve([]),
}));

vi.mock("@/lib/oauth/model-catalog", () => ({
  defaultModelFor: () => "",
  modelsFor: () => [],
}));

vi.mock("./suggested-actions", () => ({ SuggestedActions: () => null }));

globalThis.ResizeObserver ??= class {
  disconnect() {
    // Nothing is observed, so there is nothing to stop observing.
  }
  observe() {
    // Deliberately inert: see above.
  }
  unobserve() {
    // Deliberately inert: see above.
  }
};

const noop = () => undefined;
const noAttachments: never[] = [];
const noMessages: never[] = [];

/** What the composer handed `sendMessage`, in order. */
let sent: { parts: { text?: string; type: string }[] }[] = [];

/** Set by a test that wants the send to go wrong on the way out. */
let sendThrows = false;

const sendMessage = (message: unknown) => {
  if (sendThrows) {
    throw new Error("the send never left the tab");
  }
  sent.push(message as { parts: { text?: string; type: string }[] });
  return Promise.resolve();
};

/** The live value of the `input` state the composer is driven by. */
let currentInput = "";

function Harness() {
  const [input, setInput] = useState("");
  currentInput = input;

  return (
    <MultimodalInput
      attachments={noAttachments}
      chatId="chat-1"
      clearChat={noop}
      input={input}
      isLoading={false}
      messages={noMessages}
      selectedModelId="openai/gpt-5"
      sendMessage={sendMessage}
      setAttachments={noop}
      setInput={setInput}
      setMessages={noop}
      status="ready"
      stop={noop}
    />
  );
}

function composer() {
  return render(
    <StrictMode>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </StrictMode>
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByTestId("multimodal-input") as HTMLTextAreaElement;
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId("send-button") as HTMLButtonElement;
}

async function type(text: string) {
  await act(() => {
    fireEvent.change(textarea(), { target: { value: text } });
  });
}

async function send() {
  await act(() => {
    fireEvent.click(sendButton());
  });
}

/** Lets mount effects and the submit's own microtasks run out. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the composer after a send", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    sent = [];
    sendThrows = false;
    currentInput = "";
    localStorage.clear();
  });

  it("empties both the input state and the textarea", async () => {
    composer();

    await type("Reply with exactly: ok");
    await send();

    expect(sent).toHaveLength(1);
    expect(currentInput).toBe("");
    expect(textarea().value).toBe("");
  });

  /**
   * The consequence the reviewer hit by accident: with the text still in the
   * box the Send button stays live, and the next Enter sends it again.
   */
  it("leaves nothing behind that a second send could re-send", async () => {
    composer();

    await type("Reply with exactly: ok");
    await send();
    await send();

    expect(sent).toHaveLength(1);
    expect(sendButton().disabled).toBe(true);
  });

  /**
   * Emptying the composer must not be contingent on the send succeeding. It
   * was: the clears ran after `sendMessage(...)`, so anything that stopped
   * that call from returning normally skipped all three and left the sent text
   * sitting in the box.
   *
   * Nothing is lost by clearing first, and that is what makes it safe rather
   * than merely tidy: a send that fails now reports itself in the thread with
   * a Retry (see `message-error.test.tsx`), so the reader's words are still on
   * screen and still re-sendable.
   */
  it("empties even when the send itself goes wrong", async () => {
    sendThrows = true;
    composer();

    await type("Reply with exactly: ok");
    await send();

    expect(currentInput).toBe("");
    expect(textarea().value).toBe("");
    expect(sendButton().disabled).toBe(true);
  });

  /**
   * The second route back to the same screen. The composer keeps its value in
   * three places — React state, the textarea node, the stored draft — and the
   * restore effect used to re-read the stored draft on every change and prefer
   * the *DOM* value over both. So any later write to the key refilled the box:
   * another tab, or (as instrumenting the running app showed) the persist
   * effect itself writing a stale value a beat after a send.
   *
   * The event below is exactly what `useLocalStorage` broadcasts on such a
   * write, so this drives the real mechanism rather than a description of it.
   */
  it("stays empty when something writes the old draft back to storage", async () => {
    composer();

    await type("Reply with exactly: ok");
    await send();

    await act(() => {
      localStorage.setItem("input", JSON.stringify("Reply with exactly: ok"));
      window.dispatchEvent(new StorageEvent("local-storage", { key: "input" }));
    });

    expect(currentInput).toBe("");
    expect(textarea().value).toBe("");
  });

  /**
   * The behaviour the restore effect exists to provide, and which the repair
   * must not cost: a draft typed but never sent is still there after a reload.
   * The remount below is that reload — a fresh composer over the same
   * `localStorage`.
   */
  it("still restores an unsent draft across a reload", async () => {
    const first = composer();

    await type("half-written thought");
    first.unmount();

    composer();
    await settle();

    expect(textarea().value).toBe("half-written thought");
    expect(currentInput).toBe("half-written thought");
  });

  /** And a draft restored that way is still sendable, exactly once. */
  it("sends a restored draft and then empties", async () => {
    localStorage.setItem("input", JSON.stringify("half-written thought"));

    composer();
    await settle();
    await send();

    expect(sent).toHaveLength(1);
    expect(sent[0].parts.at(-1)?.text).toBe("half-written thought");
    expect(textarea().value).toBe("");
    expect(currentInput).toBe("");
  });
});
