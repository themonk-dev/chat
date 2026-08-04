import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { getWeather } from "./ai/tools/get-weather";

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

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
 * A send that failed, carried on the transcript as a part of an assistant
 * message rather than held in `useChat`'s transient `error` field.
 *
 * That placement is the whole point. A failure is something the thread *has*,
 * in the position the reply would have occupied — so it renders where the
 * reader is already looking, survives the round trip through
 * `localStorage` that every other message survives, and comes back on reload
 * beside the question that produced it. A toast is gone in seconds and a
 * `useChat` error field is gone on the next send.
 *
 * `retryOf` is the id of the user message that failed, which is what makes
 * the Retry button possible after a reload: `regenerate({ messageId })` slices
 * the transcript back to that message and asks again, so nothing has to be
 * remembered outside the stored thread.
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
