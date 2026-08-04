"use client";

import { Shimmer } from "../ai-elements/shimmer";
import { useDataStream } from "./data-stream-provider";
import { SparklesIcon } from "./icons";

export function AssistantAvatar() {
  return (
    <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
      <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
        <SparklesIcon size={13} />
      </div>
    </div>
  );
}

export function WaitingText() {
  const { waitingStatus } = useDataStream();

  return (
    <div className="flex min-h-[calc(13px*1.65)] min-w-0 items-center text-[13px] leading-[1.65]">
      <Shimmer
        as="span"
        className="font-medium whitespace-normal break-words"
        duration={1}
      >
        {waitingStatus?.message ?? "Waiting..."}
      </Shimmer>
    </div>
  );
}

export function ThinkingMessage() {
  return (
    <div
      className="group/message w-full"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <WaitingText />
      </div>
    </div>
  );
}
