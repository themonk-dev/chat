"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback } from "react";
import type { ChatErrorData, ChatMessage } from "@/lib/types";

/**
 * Sits in the assistant column but is deliberately not dressed as a reply: a
 * quota rejection read as the model's opinion is the failure mode. The
 * provider's own sentence is the body text, unedited.
 */
export function MessageError({
  data,
  regenerate,
}: {
  data: ChatErrorData;
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}) {
  /**
   * `regenerate({ messageId })` slices the transcript back to the failed user
   * message, so a retry that fails again produces one report, not a pile.
   */
  const handleRetry = useCallback(() => {
    const { retryOf } = data;
    const attempt = retryOf ? regenerate({ messageId: retryOf }) : regenerate();

    // `onError` already reports a rejected regenerate; this only prevents a
    // duplicate unhandled-rejection log.
    Promise.resolve(attempt).catch(() => undefined);
  }, [data, regenerate]);

  return (
    <div
      className="w-fit max-w-[min(100%,60ch)] overflow-hidden rounded-2xl rounded-tl-lg border border-destructive/30 bg-destructive/5 shadow-[var(--shadow-card)]"
      data-testid="message-error"
    >
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <TriangleAlertIcon className="mt-px size-4 shrink-0 text-destructive/80" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-[13px] leading-[1.65]">
            {data.modelName} didn't reply
          </p>
          <p className="break-words text-[13px] text-muted-foreground leading-[1.65]">
            {data.detail}
          </p>
          <p className="text-[11px] text-muted-foreground/60">
            {data.providerLabel}
            {data.kind ? ` · ${data.kind}` : ""}
          </p>
        </div>
      </div>

      <div className="flex justify-end border-destructive/20 border-t px-3.5 py-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-foreground"
          data-testid="message-error-retry"
          onClick={handleRetry}
          type="button"
        >
          <RefreshCwIcon className="size-3.5" />
          Retry
        </button>
      </div>
    </div>
  );
}
