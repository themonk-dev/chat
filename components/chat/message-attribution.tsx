"use client";

import { modelNameFor } from "@/lib/oauth/model-catalog";
import { ProviderMark } from "./provider-mark";

/**
 * The ids are the ones stamped when the reply was produced, never looked up
 * live: a reply from a since-disconnected provider still says who wrote it. The
 * name is resolved at render because only the ids are worth persisting.
 */
export function MessageAttribution({
  modelId,
  providerId,
}: {
  modelId: string;
  providerId: string;
}) {
  // Foreground rather than muted: five marks use `currentColor` and would wash
  // out beside Claude's and Gemini's hard-coded brand fills.
  return (
    <p
      className="flex items-center gap-1.5 text-[11px] text-foreground"
      data-testid="message-attribution"
    >
      <span>by</span>
      <ProviderMark className="size-3.5" providerId={providerId} />
      <span>{modelNameFor(providerId, modelId)}</span>
    </p>
  );
}
