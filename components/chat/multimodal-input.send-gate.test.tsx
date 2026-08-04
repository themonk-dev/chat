import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import { MultimodalInput } from "./multimodal-input";

/**
 * The send gate asks one question: is the provider this request would
 * actually be addressed to connected? That is the *model owner*, which
 * `resolveRequest` already derives correctly — not whichever provider happens
 * to be active. The two are deliberately allowed to differ, so a gate built
 * on the active provider says "not connected" about a request that is
 * perfectly sendable, and refuses to send it.
 *
 * Everything the composer reaches for is mocked at the module boundary: the
 * selection and connection map (owned by `use-active-chat`), the auth hook,
 * the router/theme/storage hooks, and the model list. What is left real is
 * the button, its `disabled` computation, and the tooltip beside it — which
 * is the whole of what is under test.
 */

type Auth = {
  activeId: string;
  setActiveId: () => void;
  tokens: { accessToken: string } | undefined;
};

let owner: string | undefined;
let connected: ConnectedProviders = new Map();
let auth: Auth = {
  activeId: "openrouter",
  setActiveId: () => undefined,
  tokens: undefined,
};

/**
 * `resolveRequest` is deliberately *not* mocked: it is the answer the gate is
 * supposed to be asking for, so a test that stubbed it would be asserting
 * against a second copy of the thing under test.
 */
vi.mock("@/hooks/use-active-chat", () => ({
  getSelectionProviderId: () => owner,
}));

vi.mock("@/hooks/use-connected-providers", () => ({
  useConnectedProviders: () => connected,
}));

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => auth,
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

/*
 * `use-active-chat` is imported for real above (for `resolveRequest`), so
 * these two mocks have to satisfy its module-level named imports as well as
 * the composer's own.
 */
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

/**
 * Radix's popper measures its trigger once the tooltip opens, and jsdom ships
 * no `ResizeObserver`. Nothing here depends on the measurement — only on the
 * text that gets rendered — so an inert observer is enough.
 */
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

/**
 * Hoisted so the composer's props are referentially stable across renders —
 * `MultimodalInput` is memoized on them, and a fresh closure per render would
 * defeat that in the test the way the linter warns it would in the app.
 */
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

function sendButton(): HTMLButtonElement {
  return screen.getByTestId("send-button") as HTMLButtonElement;
}

describe("the send gate", () => {
  /**
   * `vitest.config.ts` registers no setup file, so React Testing Library's
   * automatic per-test unmount is not installed — without this every render
   * accumulates in the same document and `getByTestId` finds four send
   * buttons by the last case.
   */
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    owner = undefined;
    connected = new Map();
    auth = {
      activeId: "openrouter",
      setActiveId: () => undefined,
      tokens: undefined,
    };
  });

  /**
   * The reviewer's repro, two clicks and no race:
   *
   * 1. Claude and Grok are both connected, and a Claude model is selected —
   *    so `owner === "claude"` while `activeId === "xai"`, the exact state a
   *    successful connect deliberately leaves behind
   *    (`components/chat/manage-providers.tsx:160-175`).
   * 2. Manage Providers -> disconnect **Grok**. `handleDisconnect` sees
   *    `id === activeId`, so it calls `useProviderAuth`'s `disconnect()` and
   *    `isConnected` goes false.
   * 3. The recovery effect asks `nextSelection`, finds the Claude owner still
   *    connected, and returns `{kind: "keep"}` — `activeId` is never moved off
   *    the now-disconnected `xai`, on purpose.
   *
   * The picker still shows the Claude mark and a Claude model, and
   * `resolveRequest` would still produce a Claude request with a Claude
   * token. A gate built on `isConnected` nonetheless greys the button out
   * permanently, and tells the reader to connect a provider they already have.
   */
  it("enables the send when the model's owner is connected, even though the active provider is not", () => {
    owner = "claude";
    connected = new Map([["claude", "claude-secret"]]);
    auth = { activeId: "xai", setActiveId: () => undefined, tokens: undefined };

    renderComposer(<Composer selectedModelId="claude-sonnet-4-5" />);

    expect(sendButton().disabled).toBe(false);
  });

  /**
   * The mirror case, which the gate must keep refusing: the active provider
   * holds a token, but the selection belongs to somebody who does not. The
   * resolver would hand the transport `accessToken: undefined` here, so
   * letting the click through would only produce a thrown send.
   */
  it("keeps the send disabled when the model's owner is not connected, whatever the active provider holds", () => {
    owner = "claude";
    connected = new Map([["xai", "xai-secret"]]);
    auth = {
      activeId: "xai",
      setActiveId: () => undefined,
      tokens: { accessToken: "xai-secret" },
    };

    renderComposer(<Composer selectedModelId="claude-sonnet-4-5" />);

    expect(sendButton().disabled).toBe(true);
  });

  /**
   * The gap right after a fresh connect: `useProviderAuth` already holds the
   * active provider's token but the connection map's own storage read has not
   * resolved yet. `resolveRequest` covers it with the same `activeAccessToken`
   * fallback, guarded the same way — only when the owner *is* the active
   * provider — so the gate must not disagree with it and blank the button out
   * for a render or two.
   */
  it("accepts the active provider's own token before the connection map has caught up", () => {
    owner = "openrouter";
    connected = new Map();
    auth = {
      activeId: "openrouter",
      setActiveId: () => undefined,
      tokens: { accessToken: "openrouter-secret" },
    };

    renderComposer(<Composer selectedModelId="openai/gpt-5" />);

    expect(sendButton().disabled).toBe(false);
  });

  /** Nothing selected and nothing connected: the honest empty state. */
  it("keeps the send disabled when nothing has been selected at all", () => {
    renderComposer(<Composer selectedModelId="" />);

    expect(sendButton().disabled).toBe(true);
  });

  /**
   * The hint has to name the provider the reader actually has to sign into.
   * "Connect a provider" is what made the original report read as nonsense:
   * it was shown beside a popover reporting one connected provider, about a
   * different one.
   */
  it("names the model's owner in the hint rather than saying 'a provider'", () => {
    owner = "claude";
    connected = new Map([["xai", "xai-secret"]]);
    auth = {
      activeId: "xai",
      setActiveId: () => undefined,
      tokens: { accessToken: "xai-secret" },
    };

    renderComposer(<Composer selectedModelId="claude-sonnet-4-5" />);
    // Radix opens the tooltip on focus as well as hover, and focus is the
    // one of the two jsdom dispatches faithfully.
    fireEvent.focus(screen.getByTestId("send-hint-trigger"));

    expect(
      screen.getAllByText("Connect Claude to send a message").length
    ).toBeGreaterThan(0);
  });

  /** With no selection there is no particular provider to point at. */
  it("falls back to the generic hint when nothing is selected", () => {
    renderComposer(<Composer selectedModelId="" />);
    fireEvent.focus(screen.getByTestId("send-hint-trigger"));

    expect(
      screen.getAllByText("Connect a provider to send a message").length
    ).toBeGreaterThan(0);
  });
});
