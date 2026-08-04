"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback } from "react";
import type { ChatErrorData, ChatMessage } from "@/lib/types";

/**
 * A failed send, rendered where the reply would have been.
 *
 * Attributed to the assistant — it sits inside the assistant column, under
 * the same avatar a real reply gets — but deliberately not dressed as one: the
 * destructive border and the warning mark say at a glance that this is the
 * app reporting, not a model answering. Getting that wrong in either direction
 * is the failure mode. A block that looks like an ordinary reply invites
 * someone to read a quota rejection as the model's opinion; a block styled as
 * a system banner floats free of the conversation and stops answering the
 * question "what happened to my message".
 *
 * The provider's own sentence is the body text, unedited. It is the only part
 * of this that carries information the reader cannot already see, and it is
 * routinely actionable in a way a rewrite would not be — "You have exhausted
 * your capacity on this model" tells them to pick another model, which
 * "Something went wrong" does not.
 */
export function MessageError({
  data,
  regenerate,
}: {
  data: ChatErrorData;
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}) {
  /**
   * Asks the model again for the message that failed, rather than appending
   * the reader's text as a new turn.
   *
   * `regenerate({ messageId })` slices the transcript back to that user
   * message and re-requests from there, which takes this report and any
   * partial reply above it with it — so a retry that fails again produces one
   * report, not a growing pile. A thread whose user message has since been
   * edited away has no id to point at; regenerating the tail is the closest
   * thing to "ask again" still available, and is what a reader means by
   * Retry either way.
   */
  const handleRetry = useCallback(() => {
    const { retryOf } = data;
    const attempt = retryOf ? regenerate({ messageId: retryOf }) : regenerate();

    Promise.resolve(attempt).catch(() => {
      /*
       * A rejected regenerate has already been reported by `onError`, which
       * appends a fresh failure exactly as the original send did. Catching
       * here only prevents a duplicate unhandled-rejection log.
       */
    });
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
