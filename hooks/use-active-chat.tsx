"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import type { DataUIPart } from "ai";
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
import { useChatIdForPath, useStoredMessages } from "@/hooks/use-chat-id";
import { useConnectedProviders } from "@/hooks/use-connected-providers";
import { useModelSelection } from "@/hooks/use-model-selection";
import { usePersistChat } from "@/hooks/use-persist-chat";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { failureMessage, isBlankReply } from "@/lib/chats/failure-message";
import { deleteChat } from "@/lib/chats/store";
import { resolveRequest } from "@/lib/oauth/selection";
import { OAuthChatTransport } from "@/lib/oauth/transport";
import { describeSendFailure } from "@/lib/send-failure";
import type { ChatMessage, CustomUIDataTypes } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

export { getSelectionProviderId } from "@/hooks/use-model-selection";

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
  /** `providerId` defaults to the active provider; the picker always passes it. */
  setCurrentModelId: (id: string, providerId?: string) => void;
  clearChat: () => void;
};

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

/** Keeps a ref in step with a value, for readers that run outside render. */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream, setWaitingStatus } = useDataStream();
  const { chatId, isNewChat } = useChatIdForPath(pathname);

  const { activeId, tokens, setActiveId } = useProviderAuth();
  const connected = useConnectedProviders();
  const { currentModelId, select, selectionRef } = useModelSelection({
    activeId,
    connected,
    setActiveId,
  });

  const activeIdRef = useLatestRef(activeId);
  const tokensRef = useLatestRef(tokens);
  const connectedRef = useLatestRef(connected);

  const [input, setInput] = useState("");
  const initialMessages = useStoredMessages(chatId);

  /**
   * `onError` is declared in the options object below, before `useChat` has
   * returned, so the failure report has nothing to append to without this.
   */
  const setMessagesRef = useRef<
    UseChatHelpers<ChatMessage>["setMessages"] | undefined
  >(undefined);

  /**
   * Both failure paths land here: a transport that throws before a stream
   * exists, and an `{type:"error"}` chunk mid-flight, which the SDK rethrows
   * into the same catch. The toast draws the eye; the message survives reload.
   */
  const reportFailure = useCallback(
    (error: unknown) => {
      toast({ description: describeSendFailure(error).detail, type: "error" });

      setMessagesRef.current?.((previous) => {
        const report = failureMessage({
          error,
          messages: previous,
          modelId: selectionRef.current.modelId,
          providerId: selectionRef.current.providerId ?? activeIdRef.current,
        });

        // The empty bubble the SDK opened is the carcass of the answer that
        // never came, so the report replaces it; real partial text is kept.
        return isBlankReply(previous.at(-1))
          ? [...previous.slice(0, -1), report]
          : [...previous, report];
      });
    },
    [activeIdRef, selectionRef]
  );

  const handleDataPart = useCallback(
    (dataPart: DataUIPart<CustomUIDataTypes>) => {
      if (dataPart.type === "data-waiting-status") {
        setWaitingStatus(dataPart.data);
        return;
      }

      setDataStream((stream) => (stream ? [...stream, dataPart] : []));
    },
    [setDataStream, setWaitingStatus]
  );

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
    onData: handleDataPart,
    onError: reportFailure,
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
    transport: new OAuthChatTransport(() =>
      resolveRequest({
        activeAccessToken: tokensRef.current?.accessToken,
        activeId: activeIdRef.current,
        connected: connectedRef.current,
        modelId: selectionRef.current.modelId,
        owner: selectionRef.current.providerId,
      })
    ),
  });

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  useEffect(() => {
    if (status === "submitted" || status === "ready" || status === "error") {
      setWaitingStatus(undefined);
    }
  }, [status, setWaitingStatus]);

  const prevChatIdRef = useRef(chatId);

  useEffect(() => {
    if (prevChatIdRef.current === chatId) {
      return;
    }

    prevChatIdRef.current = chatId;

    if (isNewChat) {
      setMessages([]);
    }
  }, [chatId, isNewChat, setMessages]);

  const hasAppendedQueryRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");

    if (!query || hasAppendedQueryRef.current) {
      return;
    }

    hasAppendedQueryRef.current = true;
    window.history.replaceState({}, "", `/chat/${chatId}`);
    sendMessage({ parts: [{ text: query, type: "text" }], role: "user" });
  }, [sendMessage, chatId]);

  usePersistChat({ chatId, messages, status });

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
      setCurrentModelId: select,
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
      select,
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
