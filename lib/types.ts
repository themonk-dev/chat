import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { getWeather } from "./ai/tools/get-weather";

/**
 * Which provider answered, and with which model.
 *
 * A thread here is deliberately not bound to a provider (`lib/chats/store.ts`
 * says why), and the picker offers every connected provider's models at once —
 * so one thread can hold a Claude reply followed by a Grok one, and nothing
 * else in a stored message says which was which.
 *
 * The two ids travel as one object rather than as two sibling fields for the
 * same reason `selectionRef` in `hooks/use-active-chat.tsx` does: a model id
 * only means something alongside the provider it was sent to (two providers
 * resell the same model under the same name, and a slug from one provider is a
 * 404 at another). One object cannot be written half-way, and one guard on the
 * read side — `attributionOf` below — either yields both or yields nothing.
 */
export const messageAttributionSchema = z.object({
  modelId: z.string(),
  providerId: z.string(),
});

export type MessageAttribution = z.infer<typeof messageAttributionSchema>;

/**
 * Every field is optional, and that is the contract rather than an oversight:
 * this shape describes messages already sitting in readers' `localStorage`,
 * written before either field existed. Nothing may assume presence, and the
 * absence of attribution is rendered as nothing at all — never as the provider
 * that happens to be connected now.
 */
export const messageMetadataSchema = z.object({
  attribution: messageAttributionSchema.optional(),
  createdAt: z.string().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * The one way to read attribution off a message.
 *
 * Hand-written rather than a `safeParse` because it runs per assistant message
 * per render, but it makes the same judgement the schema does: metadata comes
 * back from a text file the reader's browser owns, so a half-written or
 * hand-edited pair is a real input, and half a pair is a guess with extra
 * steps. Either both ids are there, or the caller gets `undefined` and shows
 * nothing.
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
