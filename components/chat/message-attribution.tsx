"use client";

import { modelNameFor } from "@/lib/oauth/models";
import { ProviderMark } from "./provider-mark";

/**
 * Who answered, in a footnote under the reply.
 *
 * The owner asked for exactly this: *"by [provider-logo] [model-name]"*. It is
 * a footnote and is dressed as one — the same 11px muted small print the
 * composer's credit line and a failure report's provider line already use — so
 * that a thread of replies reads as a conversation with the occasional quiet
 * annotation, not as a list of labelled specimens.
 *
 * Rendered only where there is something true to say. The values are the ones
 * stamped on the message when it was produced (`lib/oauth/transport.ts`), never
 * looked up live: a reply from a provider the reader has since disconnected
 * still says who wrote it, and a message stored before this existed says
 * nothing at all rather than borrowing whoever is connected now.
 *
 * The model name is resolved at render rather than stored, because only the
 * two ids are worth persisting — a display name is presentation, and the
 * catalogue it comes from ships with the build.
 */
export function MessageAttribution({
  modelId,
  providerId,
}: {
  modelId: string;
  providerId: string;
}) {
  return (
    <p
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60"
      data-testid="message-attribution"
    >
      <span>by</span>
      <ProviderMark className="size-3.5" providerId={providerId} />
      <span>{modelNameFor(providerId, modelId)}</span>
    </p>
  );
}
