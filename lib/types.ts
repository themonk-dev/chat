import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { getWeather } from "./ai/tools/get-weather";

/**
 * One thread can hold a Claude reply followed by a Grok one, and nothing else
 * in a stored message says which. The two ids travel as one object because a
 * model id only means something alongside the provider it was sent to.
 */
export const messageAttributionSchema = z.object({
  modelId: z.string(),
  providerId: z.string(),
});

export type MessageAttribution = z.infer<typeof messageAttributionSchema>;

/**
 * Every field is optional by contract: this describes messages already in
 * readers' `localStorage`, written before either field existed.
 */
export const messageMetadataSchema = z.object({
  attribution: messageAttributionSchema.optional(),
  createdAt: z.string().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * Hand-written rather than `safeParse` because it runs per message per render,
 * but it makes the same judgement: either both ids, or nothing.
 */
export function attributionOf(
  message: { metadata?: MessageMetadata } | undefined
): MessageAttribution | undefined {
  const modelId = message?.metadata?.attribution?.modelId;
  const providerId = message?.metadata?.attribution?.providerId;

  if (typeof modelId !== "string" || typeof providerId !== "string") {
    return;
  }

  return modelId && providerId ? { modelId, providerId } : undefined;
}

type weatherTool = InferUITool<typeof getWeather>;

export type ChatTools = {
  getWeather: weatherTool;
};

export type WaitingStatusData = {
  phase: "waiting" | "still-waiting" | "health" | "thinking";
  message: string;
  modelId: string;
  modelName: string;
};

/**
 * Carried on the transcript rather than in `useChat`'s transient `error`, so a
 * failure survives the reload every other message survives. `retryOf` is what
 * makes Retry work afterwards, with nothing remembered outside the thread.
 */
export type ChatErrorData = {
  detail: string;
  kind?: string;
  modelId: string;
  modelName: string;
  providerId: string;
  providerLabel: string;
  retryOf?: string;
};

export type CustomUIDataTypes = {
  appendMessage: string;
  "chat-title": string;
  error: ChatErrorData;
  "waiting-status": WaitingStatusData;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
