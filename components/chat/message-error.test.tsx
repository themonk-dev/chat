import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/types";
import { PreviewMessage } from "./message";

/**
 * Where a failure has to appear, and what it has to say once it is there.
 *
 * The owner's words, twice: *"should be an error msg as agent reply ykwim"*.
 * So this is asserted through the real message component — the same one that
 * renders replies, reasoning blocks and tool calls — rather than around it:
 * the claim being checked is that the failure is *in the thread, on the
 * assistant's side*, which is a fact about that component's output and
 * nothing else.
 */

vi.mock("./data-stream-provider", () => ({
  useDataStream: () => ({ waitingStatus: undefined }),
}));

const noop = () => undefined;

const failed = (
  overrides: Partial<{
    detail: string;
    kind: string;
    modelName: string;
    providerLabel: string;
    retryOf: string | undefined;
  }> = {}
): ChatMessage =>
  ({
    id: "assistant-1",
    parts: [
      {
        data: {
          detail: "You have exhausted your capacity on this model",
          kind: "AI_APICallError",
          modelId: "gemini-2.5-pro",
          modelName: "Gemini 2.5 Pro",
          providerId: "gemini",
          providerLabel: "Gemini",
          retryOf: "user-1",
          ...overrides,
        },
        type: "data-error",
      },
    ],
    role: "assistant",
  }) as ChatMessage;

function renderMessage(
  message: ChatMessage,
  regenerate: (options?: { messageId?: string }) => unknown = noop
) {
  return render(
    <PreviewMessage
      addToolApprovalResponse={noop}
      isLoading={false}
      message={message}
      regenerate={
        regenerate as Parameters<typeof PreviewMessage>[0]["regenerate"]
      }
      requiresScrollPadding={false}
      setMessages={noop}
    />
  );
}

describe("a failure in the thread", () => {
  afterEach(() => {
    cleanup();
  });

  it("is rendered on the assistant's side of the conversation", () => {
    renderMessage(failed());

    const bubble = screen.getByTestId("message-assistant");

    expect(bubble.dataset.role).toBe("assistant");
    expect(
      bubble.querySelector("[data-testid='message-error']")
    ).not.toBeNull();
  });

  it("shows the provider's own sentence, not a generic apology", () => {
    renderMessage(failed());

    expect(
      screen.getByText("You have exhausted your capacity on this model")
    ).toBeDefined();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it("names the model and the provider it failed on", () => {
    renderMessage(failed());

    expect(screen.getByText("Gemini 2.5 Pro didn't reply")).toBeDefined();
    expect(screen.getByText(/Gemini · AI_APICallError/)).toBeDefined();
  });

  /**
   * Retry asks again for the *user's* message rather than appending a new
   * turn: `regenerate({ messageId })` slices the transcript back to it, which
   * takes this failure report with it instead of stacking a second one under
   * the first.
   */
  it("offers a retry that re-sends the message that failed", () => {
    const regenerate = vi.fn(() => Promise.resolve());

    renderMessage(failed(), regenerate);
    fireEvent.click(screen.getByTestId("message-error-retry"));

    expect(regenerate).toHaveBeenCalledWith({ messageId: "user-1" });
  });

  /** A stored thread whose user message was edited away still gets a retry. */
  it("falls back to regenerating the tail when the original message is gone", () => {
    const regenerate = vi.fn(() => Promise.resolve());
    const orphaned = failed({ retryOf: undefined });

    renderMessage(orphaned, regenerate);
    fireEvent.click(screen.getByTestId("message-error-retry"));

    expect(regenerate).toHaveBeenCalledWith();
  });

  /**
   * Survives the round trip through `localStorage` that every other message
   * survives — which is the whole reason the failure is carried as a message
   * part rather than in `useChat`'s transient error field.
   */
  it("renders the same after a reload", () => {
    const reloaded: ChatMessage = JSON.parse(JSON.stringify(failed()));

    renderMessage(reloaded);

    expect(
      screen.getByText("You have exhausted your capacity on this model")
    ).toBeDefined();
    expect(screen.getByTestId("message-error-retry")).toBeDefined();
  });
});
