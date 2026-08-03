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
 * for its connection dots, via the same two-part answer: `useProviderAuth`
 * already re-checks the *active* provider's token on every `activeId`
 * change, so that transition is mirrored into the map for free; everything
 * else is invisible to it and has to be read from storage directly.
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

  useEffect(() => {
    setConnected((previous) => {
      const next = new Map(previous);
      if (tokens?.accessToken) {
        next.set(activeId, tokens.accessToken);
      } else {
        next.delete(activeId);
      }
      return next;
    });
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

  /** Which provider `currentModelId` was picked from — see `setCurrentModelId`. */
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
      currentModelProviderRef.current = id
        ? (providerId ?? activeId)
        : undefined;
      setCurrentModelIdState(id);
    },
    [activeId]
  );

  const connected = useConnectedProviders();

  /**
   * Keeps `currentModelId` pointed at something actually usable.
   *
   * A no-op is the common case: once a model is selected, its owning
   * provider stays connected, and switching *away* from that provider
   * without disconnecting it — the ordinary case of looking at something
   * else — must not disturb the selection. Only two situations act:
   *
   * - Nothing usable is selected yet (a fresh session, or a session that
   *   never had a provider connected) and a provider's tokens are found —
   *   pick that provider's default model.
   * - The provider that owned the selected model disconnects — fall back to
   *   another connected provider's default, in `PROVIDER_ORDER`, or clear
   *   the selection if none remain. The active provider is moved to match,
   *   since a stale `activeId` would otherwise send the new selection's
   *   model id to the old provider's API.
   */
  useEffect(() => {
    const owner = currentModelProviderRef.current;
    const ownerStillConnected = owner !== undefined && connected.has(owner);

    if (currentModelId && ownerStillConnected) {
      return;
    }

    const fallback = PROVIDER_ORDER.find((id) => connected.has(id));

    if (fallback) {
      currentModelProviderRef.current = fallback;
      setCurrentModelIdState(defaultModelFor(fallback));
      if (activeId !== fallback) {
        setActiveId(fallback);
      }
    } else if (currentModelId) {
      currentModelProviderRef.current = undefined;
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
