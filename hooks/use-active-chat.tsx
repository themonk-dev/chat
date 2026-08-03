"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { toast } from "@/components/chat/toast";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { deleteChat, readChat, writeChat } from "@/lib/chats/store";
import { ChatbotError } from "@/lib/errors";
import { defaultModelFor } from "@/lib/oauth/models";
import { PROVIDER_ORDER } from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";
import { OAuthChatTransport } from "@/lib/oauth/transport";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  isLoading: boolean;
  currentModelId: string;
  /**
   * `providerId` is optional so every existing one-argument call site (and
   * the auto-recovery below, which already knows only the model id it wants)
   * keeps working: it defaults to whichever provider is active right now.
   * The model picker in `multimodal-input.tsx` always passes it explicitly,
   * because that is the one call site where "the provider the model came
   * from" and "the provider that happens to be active" can differ.
   */
  setCurrentModelId: (id: string, providerId?: string) => void;
  clearChat: () => void;
};

/** Tokens for every provider that currently holds one, not just the active one. */
export type ConnectedProviders = Map<string, string>;

/**
 * Which providers currently hold a token, independent of which one is
 * active — the same problem `components/chat/provider-selector.tsx` solves
 * for its connection dots, via a similar two-part answer: the *active*
 * provider's entry is kept current reactively (see the first effect below
 * for why that re-reads storage itself rather than trusting
 * `useProviderAuth`'s `tokens` directly); everything else is invisible to
 * it and has to be read from storage directly.
 *
 * That file only does the storage read while its menu is open, since
 * nothing needs the full set before then. Here, both callers (the picker's
 * trigger, and the recovery effect below) need an answer before anything is
 * ever opened, so the full read happens once on mount instead, then is kept
 * current by the reactive half above.
 */
export function useConnectedProviders(): ConnectedProviders {
  const { activeId, tokens } = useProviderAuth();
  const [connected, setConnected] = useState<ConnectedProviders>(new Map());

  /**
   * Re-reads storage for `activeId` directly rather than trusting `tokens`
   * from `useProviderAuth`. `tokens` genuinely lags `activeId` by a commit:
   * `setActiveId` does not clear it, and `useProviderAuth` only replaces it
   * once its own async `clientFor(activeId).getTokens()` resolves. On the
   * very commit `activeId` changes, `tokens` is still the *previous*
   * provider's `TokenSet` — trusting it here would file that token under the
   * new `activeId`, which is exactly how one provider's OAuth token ends up
   * addressed to another provider's API host two hops downstream, through
   * `fetchModelsFor` -> `GET /api/upstream/<newProvider>/models` carrying
   * the old provider's bearer token.
   *
   * A "does `tokens.provider` match `activeId`" check would catch that
   * mismatch when `tokens` is a stale-but-present `TokenSet`, but not the
   * mirror case: `tokens` genuinely undefined (the previous provider was
   * disconnected) is indistinguishable, by a tag alone, from "no answer yet
   * for the new provider" — and wrongly deleting a *different*, genuinely
   * connected provider's entry is the disconnect-recovery bug (a model
   * picked from a provider that was never touched silently reverting).
   * Re-reading independently sidesteps both: `tokens` stays in the
   * dependency array purely as a trigger — connecting a provider that is
   * already active changes `tokens` without changing `activeId`, and that
   * transition still has to be picked up — but the value written for `id`
   * always comes from asking storage about `id` itself, and a superseded
   * read (`activeId` having moved on again before this one resolves) is
   * dropped rather than applied.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokens is a deliberate trigger-only dependency, not read in the body — see the comment above.
  useEffect(() => {
    let cancelled = false;
    const id = activeId;

    clientFor(id)
      .getTokens()
      .catch(() => undefined)
      .then((found) => {
        if (cancelled) {
          return;
        }
        setConnected((previous) => {
          const next = new Map(previous);
          if (found?.accessToken) {
            next.set(id, found.accessToken);
          } else {
            next.delete(id);
          }
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, tokens]);

  useEffect(() => {
    let cancelled = false;

    Promise.all(
      PROVIDER_ORDER.map(async (id) => {
        const found = await clientFor(id)
          .getTokens()
          .catch(() => undefined);
        return [id, found?.accessToken] as const;
      })
    ).then((results) => {
      if (cancelled) {
        return;
      }
      setConnected((previous) => {
        const next = new Map(previous);
        for (const [id, token] of results) {
          if (token) {
            next.set(id, token);
          } else {
            next.delete(id);
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return connected;
}

/**
 * Which provider `currentModelId` was picked from, mirrored outside React
 * state.
 *
 * `ActiveChatProvider` itself does not remount when the route changes
 * between `/` and `/chat/[id]` — only its descendants do, including
 * `MultimodalInput` and the model picker inside it. A component-local ref
 * in the picker loses the model-to-provider association on every such
 * navigation, even though `currentModelId` itself survives untouched in
 * this provider one level up: the picker would render "Select a model"
 * for a selection that is still live and sendable. A module-level value,
 * written in lockstep with `currentModelId` — by the same
 * `setCurrentModelId` call and the same recovery effect below, never a
 * separate write — survives exactly as long as `currentModelId` does,
 * without adding a 15th member to the frozen context contract.
 */
let lastSelectionProviderId: string | undefined;

/** Read-only outside this module; only `ActiveChatProvider` writes it. */
export function getSelectionProviderId(): string | undefined {
  return lastSelectionProviderId;
}

export type SelectionOutcome =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; modelId: string; providerId: string };

/**
 * The pure half of the recovery effect below: given the current connection
 * map, the current selection, and which provider that selection belongs to,
 * decides what (if anything) should change. Extracted the same way
 * `shouldPersistChat` was — the effect's job shrinks to applying the
 * decision (writing the ref, the module mirror, `setActiveId`), which is
 * the part that actually needs a DOM/React environment to exercise.
 *
 * `PROVIDER_ORDER` is the fallback order deliberately, not connection
 * recency or any other ordering: it is the same order the provider
 * dropdown lists, so "which provider did the picker fall back to" reads as
 * the same list a reader already understands, not a hidden recency queue.
 */
export function nextSelection({
  connected,
  currentModelId,
  owner,
}: {
  connected: ConnectedProviders;
  currentModelId: string;
  owner: string | undefined;
}): SelectionOutcome {
  const ownerStillConnected = owner !== undefined && connected.has(owner);

  if (currentModelId && ownerStillConnected) {
    return { kind: "keep" };
  }

  const fallback = PROVIDER_ORDER.find((id) => connected.has(id));

  if (fallback) {
    return {
      kind: "set",
      modelId: defaultModelFor(fallback),
      providerId: fallback,
    };
  }

  return currentModelId ? { kind: "clear" } : { kind: "keep" };
}

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * The transcript exactly as it would be stored. Nothing cheaper is safe:
 * every abbreviation tried here has been a bug. A message count misses a
 * change that keeps the length (clear-then-send, edit-and-regenerate); a
 * sequence of message ids misses a change that keeps the ids, which is what
 * `addToolApprovalResponse` does — it rewrites the last message's `parts` in
 * place via `replaceMessage(messages.length - 1, { ...lastMessage, parts })`,
 * so denying a tool call produces an identical id sequence of identical
 * length and only the part's `state`/`approval` differ.
 *
 * `JSON.stringify` is the right comparison specifically because it is what
 * `writeChat` serialises with: two transcripts with the same signature would
 * produce the same bytes in `localStorage`, so skipping the write is exactly
 * a no-op, and anything that would change those bytes is seen. Stored
 * messages come back through `JSON.parse` of that same text, so key order —
 * which `JSON.stringify` preserves from insertion order — round-trips
 * faithfully and merely opening a thread still compares equal.
 */
function transcriptSignature(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

/**
 * Loading a stored thread hands `useChat` a non-empty `messages` array and a
 * `status` of `"ready"` immediately — the same shape as a real reply having
 * just finished. Comparing against a hand-maintained "last persisted count"
 * used to guard against that, but a count is derived state: anything that
 * changes `messages` without touching `chatId` (clearing, editing a message
 * and regenerating) can desynchronise it, and a count collision then makes a
 * real exchange silently fail to persist — self-healing on the next
 * differing count, which makes it nasty to notice.
 *
 * Comparing the live transcript against what is actually stored for this
 * thread has no state to desynchronise, and comparing its *content* rather
 * than its shape leaves nothing for a change to hide behind: it is correct
 * for opening a thread (the bytes match what was just loaded from the same
 * place), for a genuine send or completed reply, for the same-count cases,
 * and for an in-place rewrite such as a denied tool approval.
 *
 * The cost is a full serialisation of the thread, which is affordable
 * because of where this sits: the `status !== "ready"` gate above rejects
 * every render during streaming, and `messages` is unrelated to the input
 * textbox, so this runs once per settled turn — not per keystroke.
 */
export function shouldPersistChat({
  status,
  messages,
  storedMessages,
}: {
  status: string;
  messages: readonly unknown[];
  storedMessages: readonly unknown[];
}): boolean {
  if (status !== "ready" || messages.length === 0) {
    return false;
  }

  try {
    return (
      transcriptSignature(messages) !== transcriptSignature(storedMessages)
    );
  } catch {
    /*
     * A transcript that will not serialise cannot be compared, and would not
     * survive `writeChat` either. Answering "yes, write" keeps the failure in
     * one place — the store's own guarded write — rather than adding a second
     * silent way to lose a turn.
     */
    return true;
  }
}

/**
 * Owns the whole persistence decision: reads what is actually stored for
 * `chatId` and writes only when the live transcript differs from it. Takes
 * plain values rather than pulling from `useChat` itself so it can be driven
 * directly in a test — chatId/messages/status in, a write (or not) out —
 * without needing to stand up a real chat session.
 */
export function usePersistChat({
  chatId,
  messages,
  status,
}: {
  chatId: string;
  messages: ChatMessage[];
  status: string;
}): void {
  useEffect(() => {
    if (status !== "ready" || messages.length === 0) {
      return;
    }

    const storedMessages = readChat(chatId)?.messages ?? [];

    if (!shouldPersistChat({ messages, status, storedMessages })) {
      return;
    }

    const first = messages.find((message) => message.role === "user");
    const title =
      first?.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .slice(0, 60) || "New chat";

    writeChat({ id: chatId, messages, title, updatedAt: Date.now() });
  }, [chatId, messages, status]);
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream, setWaitingStatus } = useDataStream();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  /**
   * Starts empty rather than on any hard-coded model: with nothing connected
   * there is nothing to offer, and an empty picker is the honest state, not
   * a broken one. The effect below fills it in the moment a provider's
   * tokens are found, and keeps it pointed at something usable after that.
   */
  const [currentModelId, setCurrentModelIdState] = useState("");
  const currentModelIdRef = useRef(currentModelId);
  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  /**
   * Which provider `currentModelId` was picked from — see `setCurrentModelId`.
   * Every write here has a matching write to `lastSelectionProviderId`
   * (the module-level mirror above): this ref is the value the recovery
   * effect below reads back on its own next run, the module value is the
   * same answer exposed to components outside this provider that need it
   * to survive a remount this component itself does not undergo.
   */
  const currentModelProviderRef = useRef<string | undefined>(undefined);

  const { activeId, tokens, setActiveId } = useProviderAuth();
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const tokensRef = useRef(tokens);
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  /**
   * `providerId` defaults to whichever provider is active right now, which
   * is exactly right for every call this file makes itself (the recovery
   * effect below always sets a model for the provider it just decided is
   * active). The model picker passes it explicitly instead, because
   * selecting a model there also switches the active provider to match — by
   * the time this runs, `activeId` may already have moved on to a *third*
   * provider if the reader clicked twice quickly, so the picker cannot rely
   * on it and threads the real answer through instead.
   */
  const setCurrentModelId = useCallback(
    (id: string, providerId?: string) => {
      const owner = id ? (providerId ?? activeId) : undefined;
      currentModelProviderRef.current = owner;
      lastSelectionProviderId = owner;
      setCurrentModelIdState(id);
    },
    [activeId]
  );

  const connected = useConnectedProviders();

  /**
   * Applies `nextSelection`'s decision. A no-op (`"keep"`) is the common
   * case: once a model is selected, its owning provider stays connected,
   * and switching *away* from that provider without disconnecting it — the
   * ordinary case of looking at something else — must not disturb the
   * selection. `"set"` covers both nothing usable being selected yet (a
   * fresh session, or one that never had a provider connected) and the
   * owning provider having disconnected; either way the active provider is
   * moved to match, since a stale `activeId` would otherwise send the new
   * selection's model id to the old provider's API. `"clear"` is the same
   * disconnect with nothing left to fall back to.
   */
  useEffect(() => {
    const outcome = nextSelection({
      connected,
      currentModelId,
      owner: currentModelProviderRef.current,
    });

    if (outcome.kind === "set") {
      currentModelProviderRef.current = outcome.providerId;
      lastSelectionProviderId = outcome.providerId;
      setCurrentModelIdState(outcome.modelId);
      if (activeId !== outcome.providerId) {
        setActiveId(outcome.providerId);
      }
    } else if (outcome.kind === "clear") {
      currentModelProviderRef.current = undefined;
      lastSelectionProviderId = undefined;
      setCurrentModelIdState("");
    }
  }, [connected, currentModelId, activeId, setActiveId]);

  const [input, setInput] = useState("");

  const initialMessages: ChatMessage[] = readChat(chatId)?.messages ?? [];

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    generateId: generateUUID,
    id: chatId,
    messages: initialMessages,
    onData: (dataPart) => {
      if (dataPart.type === "data-waiting-status") {
        setWaitingStatus(dataPart.data);
        return;
      }
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onError: (error) => {
      if (error instanceof ChatbotError) {
        toast({ description: error.message, type: "error" });
      } else {
        toast({
          description: error.message || "Oops, an error occurred!",
          type: "error",
        });
      }
    },
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new OAuthChatTransport(() => ({
      accessToken: tokensRef.current?.accessToken,
      modelId: currentModelIdRef.current,
      providerId: activeIdRef.current,
    })),
  });

  useEffect(() => {
    if (status === "submitted" || status === "ready" || status === "error") {
      setWaitingStatus(undefined);
    }
  }, [status, setWaitingStatus]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendMessage({
        parts: [{ text: query, type: "text" }],
        role: "user" as const,
      });
    }
  }, [sendMessage, chatId]);

  usePersistChat({ chatId, messages, status });

  /**
   * Clearing needs no special handling from `usePersistChat`: it empties
   * the messages and deletes the store entry, and the next settled render
   * simply finds nothing stored for this `chatId` — so any new exchange,
   * whatever its eventual length, is seen as new content by construction.
   */
  const clearChat = useCallback(() => {
    setMessages(() => []);
    deleteChat(chatId);
  }, [chatId, setMessages]);

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      addToolApprovalResponse,
      chatId,
      clearChat,
      currentModelId,
      input,
      isLoading: false,
      messages,
      regenerate,
      sendMessage,
      setCurrentModelId,
      setInput,
      setMessages,
      status,
      stop,
    }),
    [
      chatId,
      clearChat,
      messages,
      setMessages,
      sendMessage,
      status,
      stop,
      regenerate,
      addToolApprovalResponse,
      input,
      currentModelId,
      setCurrentModelId,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
