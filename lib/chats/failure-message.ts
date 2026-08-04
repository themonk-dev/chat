import { modelNameFor } from "@/lib/oauth/model-catalog";
import { registry } from "@/lib/oauth/registry";
import { describeSendFailure } from "@/lib/send-failure";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

/**
 * A send opens its assistant message before a token arrives, so a failure finds
 * one holding only bookkeeping parts. Judged by what renders, so a reply that
 * produced real text before dying is never mistaken for an empty one.
 */
export function isBlankReply(message: ChatMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }

  return !message.parts.some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }

    return part.type !== "step-start";
  });
}

/**
 * A failure becomes its own assistant message rather than a part on the last
 * one: a stream that died halfway leaves a real partial reply behind, and the
 * reader needs both, in order.
 *
 * `retryOf` points at the user's message so Retry survives a reload.
 */
export function failureMessage({
  error,
  messages,
  modelId,
  providerId,
}: {
  error: unknown;
  messages: readonly ChatMessage[];
  modelId: string;
  providerId: string;
}): ChatMessage {
  const { detail, kind } = describeSendFailure(error);
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return {
    id: generateUUID(),
    metadata: {
      attribution: { modelId, providerId },
      createdAt: new Date().toISOString(),
    },
    parts: [
      {
        data: {
          detail,
          ...(kind ? { kind } : {}),
          modelId,
          modelName: modelNameFor(providerId, modelId),
          providerId,
          providerLabel: registry[providerId]?.label ?? providerId,
          ...(lastUserMessage ? { retryOf: lastUserMessage.id } : {}),
        },
        type: "data-error",
      },
    ],
    role: "assistant",
  };
}
