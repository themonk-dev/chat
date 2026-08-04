"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { ReactNode } from "react";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { MessageError } from "./message-error";
import { MessageReasoning } from "./message-reasoning";
import { WeatherToolPart } from "./message-weather-tool";

type Parts = NonNullable<ChatMessage["parts"]>;

const USER_BUBBLE_CLASS =
  "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 shadow-[var(--shadow-card)]";

/**
 * Reasoning arrives as several parts but reads as one block, so they are joined
 * and rendered at the position of the first.
 */
function mergedReasoning(parts: Parts | undefined) {
  const texts: string[] = [];
  let isStreaming = false;

  for (const part of parts ?? []) {
    if (part.type === "reasoning" && part.text?.trim().length > 0) {
      texts.push(part.text);
      isStreaming = "state" in part ? part.state === "streaming" : false;
    }
  }

  return { isStreaming, text: texts.join("\n\n") };
}

export function renderParts({
  addToolApprovalResponse,
  isLoading,
  message,
  regenerate,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  isLoading: boolean;
  message: ChatMessage;
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}): ReactNode[] {
  const reasoning = mergedReasoning(message.parts);
  let reasoningRendered = false;

  return (message.parts ?? []).map((part, index) => {
    const key = `message-${message.id}-part-${index}`;

    if (part.type === "reasoning") {
      if (reasoningRendered || !reasoning.text) {
        return null;
      }

      reasoningRendered = true;

      return (
        <MessageReasoning
          isLoading={isLoading || reasoning.isStreaming}
          key={key}
          reasoning={reasoning.text}
        />
      );
    }

    if (part.type === "text") {
      return (
        <MessageContent
          className={cn("text-[13px] leading-[1.65]", {
            [USER_BUBBLE_CLASS]: message.role === "user",
          })}
          data-testid="message-content"
          key={key}
        >
          <MessageResponse>{sanitizeText(part.text)}</MessageResponse>
        </MessageContent>
      );
    }

    if (part.type === "data-error") {
      return (
        <MessageError data={part.data} key={key} regenerate={regenerate} />
      );
    }

    if (part.type === "tool-getWeather") {
      return (
        <WeatherToolPart
          addToolApprovalResponse={addToolApprovalResponse}
          key={part.toolCallId}
          part={part}
        />
      );
    }

    return null;
  });
}
