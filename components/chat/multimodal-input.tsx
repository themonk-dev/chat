"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import { toast } from "sonner";
import { useWindowSize } from "usehooks-ts";
import { getSelectionProviderId } from "@/hooks/use-active-chat";
import { useAutoFocus, useComposerDraft } from "@/hooks/use-composer-draft";
import { useConnectedProviders } from "@/hooks/use-connected-providers";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import { registry } from "@/lib/oauth/registry";
import { resolveRequest } from "@/lib/oauth/selection";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PromptInput, PromptInputTextarea } from "../ai-elements/prompt-input";
import { ComposerActions } from "./composer-actions";
import { ComposerAttribution } from "./composer-attribution";
import { ComposerEditBanner } from "./composer-edit-banner";
import { SlashCommandMenu } from "./slash-commands";
import { SuggestedActions } from "./suggested-actions";

const DESKTOP_WIDTH = 768;

type MultimodalInputProps = {
  chatId: string;
  clearChat: () => void;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedModelId: string;
  onModelChange?: (modelId: string, providerId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
};

function PureMultimodalInput({
  chatId,
  clearChat,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedModelId,
  onModelChange,
  editingMessage,
  onCancelEdit,
  isLoading,
}: MultimodalInputProps) {
  const { activeId, tokens } = useProviderAuth();
  const connected = useConnectedProviders();

  /**
   * Asked of `resolveRequest`, the same function the transport consults — not
   * "is the active provider connected". Owner and active provider are allowed
   * to diverge, so a second derivation here would grey the button out for a
   * send that is perfectly valid.
   */
  const owner = getSelectionProviderId();
  const request = resolveRequest({
    activeAccessToken: tokens?.accessToken,
    activeId,
    connected,
    modelId: selectedModelId,
    owner,
  });
  const canSend = Boolean(request.accessToken && request.modelId);

  // Named whenever there is an owner: the usual state is one provider short,
  // not none, and "connect a provider" reads oddly beside "2 connected".
  const sendHint = owner
    ? `Connect ${registry[owner]?.label ?? owner} to send a message`
    : "Connect a provider to send a message";

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();

  useAutoFocus(textareaRef, width);

  const setStoredDraft = useComposerDraft(input, setInput);
  const {
    close: closeSlash,
    handleKeyDown: handleSlashKeyDown,
    index: slashIndex,
    open: slashOpen,
    query: slashQuery,
    select: selectSlash,
    submitTyped: submitTypedSlash,
    trackInput: trackSlashInput,
  } = useSlashCommands({ chatId, clearChat, setInput });

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setInput(event.target.value);
      trackSlashInput(event);
    },
    [setInput, trackSlashInput]
  );

  /**
   * Empties the composer, then sends what it held. These clears used to sit
   * after `sendMessage(...)`, so a failed send left the text in the box under a
   * live Send button — and a second Enter sent it twice.
   */
  const submitForm = useCallback(() => {
    const parts = [
      ...attachments.map((attachment) => ({
        mediaType: attachment.contentType,
        name: attachment.name,
        type: "file" as const,
        url: attachment.url,
      })),
      { text: input, type: "text" as const },
    ];

    setAttachments([]);
    setStoredDraft("");
    setInput("");

    window.history.pushState({}, "", `/chat/${chatId}`);

    sendMessage({ parts, role: "user" });

    if (width && width > DESKTOP_WIDTH) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    setInput,
    attachments,
    sendMessage,
    setAttachments,
    setStoredDraft,
    width,
    chatId,
  ]);

  const handlePromptSubmit = useCallback(() => {
    if (submitTypedSlash(input)) {
      return;
    }

    if (!input.trim() && attachments.length === 0) {
      return;
    }

    if (status === "ready" || status === "error") {
      submitForm();
      return;
    }

    toast.error("Please wait for the model to finish its response!");
  }, [attachments.length, input, status, submitForm, submitTypedSlash]);

  const handleTextareaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleSlashKeyDown(event)) {
        return;
      }

      if (event.key === "Escape" && editingMessage && onCancelEdit) {
        event.preventDefault();
        onCancelEdit();
      }
    },
    [editingMessage, handleSlashKeyDown, onCancelEdit]
  );

  const showSuggestions =
    !(editingMessage || isLoading) &&
    messages.length === 0 &&
    attachments.length === 0;

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit ? (
        <ComposerEditBanner onCancel={onCancelEdit} />
      ) : null}

      {showSuggestions ? (
        <SuggestedActions chatId={chatId} sendMessage={sendMessage} />
      ) : null}

      <div className="relative">
        {slashOpen ? (
          <SlashCommandMenu
            onClose={closeSlash}
            onSelect={selectSlash}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        ) : null}
      </div>

      <PromptInput
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={handlePromptSubmit}
      >
        <PromptInputTextarea
          className="min-h-24 text-[13px] leading-relaxed px-4 pt-3.5 pb-1.5 placeholder:text-muted-foreground/35"
          data-testid="multimodal-input"
          onChange={handleInput}
          onKeyDown={handleTextareaKeyDown}
          placeholder={
            editingMessage ? "Edit your message..." : "Ask anything..."
          }
          ref={textareaRef}
          value={input}
        />

        <ComposerActions
          canSend={canSend}
          connected={connected}
          hasText={Boolean(input.trim())}
          onModelChange={onModelChange}
          selectedModelId={selectedModelId}
          sendHint={sendHint}
          setMessages={setMessages}
          status={status}
          stop={stop}
        />
      </PromptInput>

      <ComposerAttribution />
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }

    if (prevProps.status !== nextProps.status) {
      return false;
    }

    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }

    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }

    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }

    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }

    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);
