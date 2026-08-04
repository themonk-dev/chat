import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/types";
import { PreviewMessage } from "./message";

/**
 * Who answered, shown under the reply.
 *
 * The owner's words: *"if we can store the model and provider in each chat
 * reply by assistant, and show that at bottom like — by [provider-logo]
 * [model-name]"*. A thread here is deliberately not bound to a provider (see
 * `lib/chats/store.ts`), and the picker offers every connected provider's
 * models at once, so two consecutive replies in one thread can genuinely come
 * from two different companies. Without this line there is nothing on screen
 * that says which.
 *
 * Asserted through the real message component, like the failure report beside
 * it: the claim is about what a reader sees at the bottom of an assistant
 * message, which is a fact about that component's output.
 */

vi.mock("./data-stream-provider", () => ({
  useDataStream: () => ({ waitingStatus: undefined }),
}));

const noop = () => undefined;
const noopRegenerate = () => Promise.resolve();

const reply = (metadata?: unknown): ChatMessage =>
  ({
    id: "assistant-1",
    ...(metadata ? { metadata } : {}),
    parts: [{ text: "42.", type: "text" }],
    role: "assistant",
  }) as ChatMessage;

const attributed = (providerId: string, modelId: string): ChatMessage =>
  reply({ attribution: { modelId, providerId } });

function renderMessage(message: ChatMessage) {
  return render(
    <PreviewMessage
      addToolApprovalResponse={noop}
      isLoading={false}
      message={message}
      regenerate={noopRegenerate}
    />
  );
}

describe("an assistant reply's attribution line", () => {
  afterEach(() => {
    cleanup();
  });

  it("names the model and marks the provider that produced it", () => {
    renderMessage(attributed("claude", "claude-sonnet-4-5"));

    const line = screen.getByTestId("message-attribution");

    expect(line).toBeDefined();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeDefined();
    // The same mark the model picker and the providers popover show, and the
    // only thing on this line that names the provider — so it carries its own
    // accessible name rather than being decorative.
    expect(screen.getByLabelText("Claude logo")).toBeDefined();
  });

  /**
   * Two providers resell the same model under the same display name, so the
   * mark is not decoration: it is the difference between "Claude Sonnet 4.5,
   * billed to Anthropic" and "Claude Sonnet 4.5, billed to OpenRouter".
   */
  it("credits the provider that served it, not the one that made the model", () => {
    renderMessage(attributed("openrouter", "anthropic/claude-sonnet-4.5"));

    expect(screen.getByLabelText("OpenRouter logo")).toBeDefined();
    expect(screen.queryByLabelText("Claude logo")).toBeNull();
  });

  /**
   * The picker lists models fetched live from each provider, so a reply can
   * name a model this build's static catalogue has never heard of. The slug is
   * the honest answer there; inventing a prettier name would not be.
   */
  it("falls back to the model's id when the catalogue does not know it", () => {
    renderMessage(attributed("xai", "grok-9-unreleased"));

    expect(screen.getByText("grok-9-unreleased")).toBeDefined();
  });

  /**
   * Everything already in a reader's `localStorage` predates this feature.
   * Guessing — crediting an old reply to whichever provider happens to be
   * connected now — is the exact bug class this codebase keeps meeting, so a
   * message with no attribution gets no line at all.
   */
  it("shows nothing at all for a message stored before attribution existed", () => {
    renderMessage(reply());

    expect(screen.queryByTestId("message-attribution")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows nothing for metadata that carries no attribution", () => {
    renderMessage(reply({ createdAt: "2026-08-03T10:00:00.000Z" }));

    expect(screen.queryByTestId("message-attribution")).toBeNull();
  });

  /** Half an attribution is a guess with extra steps. */
  it("shows nothing when only one half of the pair survived", () => {
    renderMessage(reply({ attribution: { providerId: "claude" } }));

    expect(screen.queryByTestId("message-attribution")).toBeNull();
  });

  it("renders the same after a reload", () => {
    const reloaded: ChatMessage = JSON.parse(
      JSON.stringify(attributed("gemini", "gemini-2.5-flash"))
    );

    renderMessage(reloaded);

    expect(screen.getByText("Gemini 2.5 Flash")).toBeDefined();
    expect(screen.getByLabelText("Gemini logo")).toBeDefined();
  });

  /**
   * A failure report already says "<model> didn't reply" and names the
   * provider underneath it, in this same small print. A second line saying the
   * same two things is noise, so the attribution stored on that message stays
   * stored and unrendered — the same reasoning that gives a failure report no
   * copy button.
   */
  it("leaves a failure report to name its own model", () => {
    const failed = {
      id: "assistant-2",
      metadata: {
        attribution: { modelId: "gemini-2.5-pro", providerId: "gemini" },
      },
      parts: [
        {
          data: {
            detail: "You have exhausted your capacity on this model",
            modelId: "gemini-2.5-pro",
            modelName: "Gemini 2.5 Pro",
            providerId: "gemini",
            providerLabel: "Gemini",
          },
          type: "data-error",
        },
      ],
      role: "assistant",
    } as unknown as ChatMessage;

    renderMessage(failed);

    expect(screen.getByTestId("message-error")).toBeDefined();
    expect(screen.queryByTestId("message-attribution")).toBeNull();
  });

  /** A reader's own message was never produced by a model. */
  it("says nothing about a user's own message", () => {
    renderMessage({
      ...attributed("claude", "claude-sonnet-4-5"),
      role: "user",
    } as ChatMessage);

    expect(screen.queryByTestId("message-attribution")).toBeNull();
  });
});
