"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { memo, useCallback } from "react";
import { attributionOf, type ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MessageActions } from "./message-actions";
import { MessageAttribution } from "./message-attribution";
import { renderParts } from "./message-parts";
import { AssistantAvatar, WaitingText } from "./message-waiting";

export { ThinkingMessage } from "./message-waiting";

function hasVisibleContent(message: ChatMessage): boolean {
  return Boolean(
    message.parts?.some(
      (part) =>
        (part.type === "text" && part.text?.trim().length > 0) ||
        (part.type === "reasoning" &&
          "text" in part &&
          part.text?.trim().length > 0) ||
        part.type === "data-error" ||
        part.type.startsWith("tool-")
    )
  );
}

function PurePreviewMessage({
  addToolApprovalResponse,
  message,
  isLoading,
  regenerate,
  onEdit,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  message: ChatMessage;
  isLoading: boolean;
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  onEdit?: (message: ChatMessage) => void;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  /**
   * A message that is nothing but a failure report gets no action row and no
   * attribution line: its block already says both, in the same small print.
   */
  const isFailureReport =
    isAssistant &&
    Boolean(message.parts?.every((p) => p.type === "data-error"));
  const isThinking = isAssistant && isLoading && !hasVisibleContent(message);

  const handleEdit = useCallback(() => {
    onEdit?.(message);
  }, [message, onEdit]);

  const attribution =
    isAssistant && !isFailureReport ? attributionOf(message) : undefined;

  const content = isThinking ? (
    <WaitingText />
  ) : (
    <>
      {renderParts({
        addToolApprovalResponse,
        isLoading,
        message,
        regenerate,
      })}

      {attribution ? <MessageAttribution {...attribution} /> : null}

      {isFailureReport ? null : (
        <MessageActions
          isLoading={isLoading}
          message={message}
          onEdit={onEdit ? handleEdit : undefined}
        />
      )}
    </>
  );

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant ? <AssistantAvatar /> : null}

        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

/**
 * Memoized because the transcript re-renders on every streamed chunk: without
 * this, a hundred settled messages re-render for each token of the newest one.
 */
export const PreviewMessage = memo(
  PurePreviewMessage,
  (previous, next) =>
    previous.isLoading === next.isLoading &&
    previous.onEdit === next.onEdit &&
    previous.regenerate === next.regenerate &&
    previous.addToolApprovalResponse === next.addToolApprovalResponse &&
    previous.message.id === next.message.id &&
    equal(previous.message.parts, next.message.parts) &&
    equal(previous.message.metadata, next.message.metadata)
);
