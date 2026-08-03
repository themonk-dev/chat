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
 * A cheap fingerprint of a transcript: the sequence of message ids. Every
 * message that is sent, edited-and-regenerated, or newly loaded gets a fresh
 * id (`generateId: generateUUID` above), so two transcripts with the same
 * ids in the same order are the same content — without comparing the actual
 * text, which would mean deep-comparing a long thread on every render.
 */
function messageSignature(messages: { id: string }[]): string {
  return messages.map((message) => message.id).join("|");
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
 * thread has no state to desynchronise: it is correct for opening a thread
 * (ids match what was just loaded from the same place), correct for a
 * genuine send or a completed reply (a new id appears), and correct for
 * "the count happens to coincide" cases like clear-then-send or
 * edit-and-regenerate (the trailing id is still new, even when the count
 * is not).
 */
export function shouldPersistChat({
  status,
  messages,
  storedMessages,
}: {
  status: string;
  messages: { id: string }[];
  storedMessages: { id: string }[];
}): boolean {
  if (status !== "ready" || messages.length === 0) {
    return false;
  }

  return messageSignature(messages) !== messageSignature(storedMessages);
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
