import type { TextStreamPart, ToolSet } from "ai";
import { describeSendFailure, labelledFailureText } from "@/lib/send-failure";
import type { MessageAttribution, MessageMetadata } from "@/lib/types";

/**
 * The SDK defaults mid-stream errors to "An error occurred." — right on a
 * server, useless here, where the call is made in the reader's own tab. The
 * class name is folded into the text because a string is all a stream carries.
 */
export const streamErrorText = (error: unknown): string =>
  labelledFailureText(describeSendFailure(error));

/**
 * Stamps the reply with the resolved owner at `start`, so a reply that is
 * stopped or dies halfway is still attributed. Asking again later is how a
 * reply comes to be credited to whoever the reader has since switched to.
 */
export function attributionMetadata(
  attribution: MessageAttribution
): (options: { part: TextStreamPart<ToolSet> }) => MessageMetadata | undefined {
  return ({ part }) => (part.type === "start" ? { attribution } : undefined);
}
