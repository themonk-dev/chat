import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelFor } from "@/lib/oauth/models";
import {
  ActiveChatProvider,
  disconnectProvider,
  getSelectionProviderId,
  useActiveChat,
} from "./use-active-chat";

/**
 * Drives the whole of `ActiveChatProvider` — selection, connection map and
 * the transport resolver together — because the defect these cover is
 * precisely a disagreement *between* those three. A pure test of any one of
 * them in isolation cannot see it: each is individually correct.
 *
 * Everything the provider reaches for is mocked at the module boundary:
 * `useProviderAuth` (owned by another task), the OAuth storage clients, the
 * chat store, and `useChat` itself — the AI SDK's chat machinery has nothing
 * to do with which provider a request is addressed to, and standing it up
 * would only add a real network transport to a test about what gets handed
 * to one.
 */

/** What the OAuth clients hold right now, keyed by provider id. */
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

type Tokens = { accessToken: string; provider: string } | undefined;
type Auth = {
  activeId: string;
  setActiveId: (id: string) => void;
  tokens: Tokens;
};

const setActiveId = vi.fn();
let auth: Auth = { activeId: "openrouter", setActiveId, tokens: undefined };

vi.mock("@/hooks/use-provider-auth", () => ({
  useProviderAuth: () => auth,
}));

type Resolved = {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * The resolver `useChat` would actually consult at send time. `useChat` keeps
 * the first transport it is handed for the life of the chat and ignores the
 * ones later renders build, so capturing only the first is what the real
 * send path sees — a resolver that only became correct on a later render
 * would still be wrong in the app.
 */
let resolver: (() => Resolved) | undefined;

vi.mock("@/lib/oauth/transport", () => ({
  OAuthChatTransport: class {
    constructor(resolve: () => Resolved) {
      resolver ??= resolve;
    }
  },
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/components/chat/data-stream-provider", () => ({
  useDataStream: () => ({
    setDataStream: () => undefined,
    setWaitingStatus: () => undefined,
  }),
}));

vi.mock("@/components/chat/toast", () => ({ toast: () => undefined }));

vi.mock("@/lib/chats/store", () => ({
  deleteChat: () => undefined,
  readChat: () => undefined,
  writeChat: () => undefined,
}));

const noMessages: never[] = [];
const chatHelpers = {
  addToolApprovalResponse: () => undefined,
  messages: noMessages,
  regenerate: () => undefined,
  sendMessage: () => undefined,
  setMessages: () => undefined,
  status: "ready",
  stop: () => undefined,
};

vi.mock("@ai-sdk/react", () => ({ useChat: () => chatHelpers }));

let chat: ReturnType<typeof useActiveChat> | undefined;

function Probe() {
  chat = useActiveChat();
  return null;
}

/**
 * A fresh element every time, deliberately: React bails out of re-rendering
 * a referentially identical element, so reusing one would quietly turn every
 * `rerender` below into a no-op and let a broken resolver pass.
 */
const tree = () => (
  <ActiveChatProvider>
    <Probe />
  </ActiveChatProvider>
);

describe("the transport resolver", () => {
  beforeEach(() => {
    stored.clear();
    chat = undefined;
    resolver = undefined;
    setActiveId.mockReset();
    auth = { activeId: "openrouter", setActiveId, tokens: undefined };
  });

  /**
   * The reviewer's repro, which needs no race at all:
   *
   * 1. OpenRouter is connected and active; a Claude model is picked *on
   *    OpenRouter*.
   * 2. Manage Providers -> Connect on Grok succeeds, and a successful connect
   *    deliberately leaves `activeId === "xai"`
   *    (`components/chat/manage-providers.tsx:203-213`).
   * 3. `nextSelection` returns `"keep"` — the selection's owner, OpenRouter,
   *    is still connected — so the picker goes on showing the OpenRouter mark
   *    and "Claude Sonnet 4.5", truthfully.
   * 4. The user sends without touching the picker.
   *
   * Pairing `modelId` with `activeId` at that moment addresses an OpenRouter
   * model slug to xAI, with the xAI bearer. Reversed — a slug that happens to
   * exist on the newly active provider — it is answered and billed to the
   * wrong account with nothing on screen to say so, which is why this asserts
   * the whole triple rather than just that some model id was sent.
   */
  it("pairs the model with the provider it was picked from, not with whichever provider happens to be active", async () => {
    stored.set("openrouter", "openrouter-secret");
    auth = {
      activeId: "openrouter",
      setActiveId,
      tokens: { accessToken: "openrouter-secret", provider: "openrouter" },
    };

    const { rerender } = render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      chat?.setCurrentModelId("anthropic/claude-sonnet-4.5", "openrouter");
    });

    // Grok connects, and stays active.
    stored.set("xai", "xai-secret");
    auth = {
      activeId: "xai",
      setActiveId,
      tokens: { accessToken: "xai-secret", provider: "xai" },
    };
    // `act` flushes the ref-mirroring effects, so `activeIdRef.current` is
    // "xai" by the time the resolver is asked — the assertion below is about
    // a resolver that genuinely sees a moved `activeId`, not one that has not
    // caught up yet.
    act(() => {
      rerender(tree());
    });

    expect(chat?.currentModelId).toBe("anthropic/claude-sonnet-4.5");
    expect(resolver?.()).toEqual({
      accessToken: "openrouter-secret",
      modelId: "anthropic/claude-sonnet-4.5",
      providerId: "openrouter",
    });
  });

  /**
   * The second route into the same mismatch, and the disconnect bug in its
   * own right. Claude and OpenRouter are both connected, OpenRouter is
   * active, and the selected model is Claude's. Manage Providers then
   * disconnects **Claude** — a provider that is not the active one, so
   * neither `activeId` nor `tokens` moves and nothing about the chat side's
   * own inputs changes.
   *
   * Before the fix that revocation reached only the popover's private
   * snapshot: `nextSelection` went on seeing Claude in `connected` and
   * answering `"keep"`, so a revoked provider's model stayed selected and
   * stayed in the picker. Recovery required switching the active provider
   * away and back.
   */
  it("recovers the selection when a provider is disconnected without ever being the active one", async () => {
    stored.set("openrouter", "openrouter-secret");
    stored.set("claude", "claude-secret");
    auth = {
      activeId: "openrouter",
      setActiveId,
      tokens: { accessToken: "openrouter-secret", provider: "openrouter" },
    };

    render(tree());

    await waitFor(() => {
      expect(chat?.currentModelId).toBeTruthy();
    });

    act(() => {
      chat?.setCurrentModelId("claude-sonnet-4-5", "claude");
    });
    expect(getSelectionProviderId()).toBe("claude");

    await act(async () => {
      await disconnectProvider("claude");
    });

    await waitFor(() => {
      expect(getSelectionProviderId()).toBe("openrouter");
    });

    // Claude's model is gone, and nothing is left pairing it with
    // OpenRouter's token.
    expect(chat?.currentModelId).toBe(defaultModelFor("openrouter"));
    expect(resolver?.()).toEqual({
      accessToken: "openrouter-secret",
      modelId: defaultModelFor("openrouter"),
      providerId: "openrouter",
    });
  });

  /**
   * With nothing left to fall back to, the send has to fail closed rather
   * than be re-pointed at whichever provider is active — `undefined` is what
   * the transport turns into "Connect a provider before sending a message."
   */
  it("resolves no token at all for a selection whose owner has been revoked", async () => {
    stored.set("claude", "claude-secret");
    auth = { activeId: "claude", setActiveId, tokens: undefined };

    render(tree());

    await waitFor(() => {
      expect(getSelectionProviderId()).toBe("claude");
    });

    await act(async () => {
      await disconnectProvider("claude");
    });

    await waitFor(() => {
      expect(resolver?.().accessToken).toBeUndefined();
    });
  });
});
