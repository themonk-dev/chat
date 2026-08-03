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
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { deleteChat, readChat, writeChat } from "@/lib/chats/store";
import { ChatbotError } from "@/lib/errors";
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
  setCurrentModelId: (id: string) => void;
  clearChat: () => void;
};

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

  const [currentModelId, setCurrentModelId] = useState(DEFAULT_CHAT_MODEL);
  const currentModelIdRef = useRef(currentModelId);
  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const { activeId, tokens } = useProviderAuth();
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const tokensRef = useRef(tokens);
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

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
