"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { ArrowUpIcon } from "lucide-react";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ModelSelectorCompact } from "./model-selector-compact";
import { StopButton } from "./stop-button";

export function ComposerActions({
  canSend,
  connected,
  hasText,
  onModelChange,
  selectedModelId,
  sendHint,
  setMessages,
  status,
  stop,
}: {
  canSend: boolean;
  connected: ConnectedProviders;
  hasText: boolean;
  onModelChange?: (modelId: string, providerId: string) => void;
  selectedModelId: string;
  sendHint: string;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
}) {
  const enabled = hasText && canSend;

  return (
    <PromptInputFooter className="px-3 pb-3">
      <PromptInputTools>
        <ModelSelectorCompact
          connected={connected}
          onModelChange={onModelChange}
          selectedModelId={selectedModelId}
        />
      </PromptInputTools>

      {status === "submitted" ? (
        <StopButton setMessages={setMessages} stop={stop} />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" data-testid="send-hint-trigger">
              <PromptInputSubmit
                className={cn(
                  "h-7 w-7 rounded-xl transition-all duration-200",
                  enabled
                    ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                    : "bg-muted text-muted-foreground/25 cursor-not-allowed"
                )}
                data-testid="send-button"
                disabled={!enabled}
                status={status}
                variant="secondary"
              >
                <ArrowUpIcon className="size-4" />
              </PromptInputSubmit>
            </span>
          </TooltipTrigger>
          {canSend ? null : (
            <TooltipContent side="top">{sendHint}</TooltipContent>
          )}
        </Tooltip>
      )}
    </PromptInputFooter>
  );
}
