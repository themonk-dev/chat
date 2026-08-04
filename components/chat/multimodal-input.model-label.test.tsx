import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import type { Model } from "@/lib/oauth/model-catalog";
import { MultimodalInput } from "./multimodal-input";

/**
 * The picker's label, and the flake behind "some loads show 'Select a
 * model' despite a valid token and a 200 models response".
 *
 * It is not a race, which is why it survives a reload and why nothing about
 * the timing made it reproducible. Two facts compound:
 *
 *   1. The *selection* is re-derived from the static catalogue on every
 *      load — only `activeId` is persisted, so `currentModelId` starts empty
 *      and `use-active-chat`'s recovery effect puts it back to
 *      `defaultModelFor(provider)`, a pinned id from `MODELS`.
 *   2. The *label* was resolved against the live listing alone. Once the
 *      provider's 200 lands, `fetched[id]` replaces the static list, and a
 *      provider whose live ids differ from the pinned ones — Claude answers
 *      `claude-sonnet-4-5` where the catalogue pins
 *      `claude-sonnet-4-5-20250929` — no longer contains the selected id.
 *
 * So the successful response is what breaks the label, which is exactly
 * backwards from how it reads on screen. The send button stays enabled
 * throughout, because the gate goes through `resolveRequest` and never asks
 * whether the model is in the listing — the request was always sendable.
 */

let owner: string | undefined;
let connected: ConnectedProviders = new Map();

const staticClaudeModels: Model[] = [
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1" },
];

/** What Anthropic's listing actually answers with: undated ids. */
const liveClaudeModels: Model[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
];

vi.mock("@/hooks/use-active-chat", () => ({
  getSelectionProviderId: () => owner,
}));

vi.mock("@/hooks/use-connected-providers", () => ({
  useConnectedProviders: () => connected,
}));

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => ({
    activeId: "claude",
    setActiveId: () => undefined,
    tokens: { accessToken: "claude-token" },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: () => undefined }),
}));

vi.mock("usehooks-ts", () => ({
  useLocalStorage: () => ["", () => undefined],
  useWindowSize: () => ({ height: 800, width: 1200 }),
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
  fetchModelsFor: () => Promise.resolve(liveClaudeModels),
}));

vi.mock("@/lib/oauth/model-catalog", () => ({
  defaultModelFor: () => "claude-sonnet-4-5-20250929",
  modelsFor: (id: string) => (id === "claude" ? staticClaudeModels : []),
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
const noopAsync = () => Promise.resolve();
const noAttachments: never[] = [];
const noMessages: never[] = [];

function Composer({ selectedModelId }: { selectedModelId: string }) {
  return (
    <MultimodalInput
      attachments={noAttachments}
      chatId="chat-1"
      clearChat={noop}
      input="hello"
      isLoading={false}
      messages={noMessages}
      selectedModelId={selectedModelId}
      sendMessage={noopAsync}
      setAttachments={noop}
      setInput={noop}
      setMessages={noop}
      status="ready"
      stop={noop}
    />
  );
}

function renderComposer(node: ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

/** Lets the model-listing effect resolve inside `act`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the model picker's label", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    owner = "claude";
    connected = new Map([["claude", "claude-token"]]);
  });

  it("keeps naming the selected model after the live listing replaces the catalogue", async () => {
    renderComposer(<Composer selectedModelId="claude-sonnet-4-5-20250929" />);

    // Before the listing lands the static catalogue is what `groups` holds,
    // and the label has always been right at this point.
    expect(screen.getByTestId("model-selector").textContent).toContain(
      "Claude Sonnet 4.5"
    );

    await settle();

    expect(screen.getByTestId("model-selector").textContent).not.toContain(
      "Select a model"
    );
    expect(screen.getByTestId("model-selector").textContent).toContain(
      "Claude Sonnet 4.5"
    );
  });

  /**
   * The fallback is a name for a model the reader really is on, not a
   * licence to invent one: an id in neither list still has to render as
   * _something_, and the id itself is the only honest answer left.
   * "Select a model" is reserved for actually having no selection.
   */
  it("falls back to the selected id when neither list carries it", async () => {
    renderComposer(<Composer selectedModelId="claude-some-unknown-model" />);
    await settle();

    expect(screen.getByTestId("model-selector").textContent).toContain(
      "claude-some-unknown-model"
    );
  });

  it("still says 'Select a model' when there is genuinely no selection", async () => {
    owner = undefined;
    renderComposer(<Composer selectedModelId="" />);
    await settle();

    expect(screen.getByTestId("model-selector").textContent).toContain(
      "Select a model"
    );
  });
});
