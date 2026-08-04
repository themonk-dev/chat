"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useCallback } from "react";
import type { ChatMessage } from "@/lib/types";
import { Tool, ToolContent, ToolHeader, ToolInput } from "../ai-elements/tool";
import { Weather } from "./weather";

type WeatherPart = Extract<
  NonNullable<ChatMessage["parts"]>[number],
  { type: "tool-getWeather" }
>;

const WIDTH_CLASS = "w-[min(100%,450px)]";

function ToolApprovalActions({
  addToolApprovalResponse,
  approvalId,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  approvalId: string;
}) {
  const handleDeny = useCallback(() => {
    addToolApprovalResponse({
      approved: false,
      id: approvalId,
      reason: "User denied weather lookup",
    });
  }, [addToolApprovalResponse, approvalId]);

  const handleAllow = useCallback(() => {
    addToolApprovalResponse({ approved: true, id: approvalId });
  }, [addToolApprovalResponse, approvalId]);

  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
      <button
        className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
        onClick={handleDeny}
        type="button"
      >
        Deny
      </button>
      <button
        className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
        onClick={handleAllow}
        type="button"
      >
        Allow
      </button>
    </div>
  );
}

function isDenied(part: WeatherPart): boolean {
  const { approval } = part as { approval?: { approved?: boolean } };

  return (
    part.state === "output-denied" ||
    (part.state === "approval-responded" && approval?.approved === false)
  );
}

export function WeatherToolPart({
  addToolApprovalResponse,
  part,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  part: WeatherPart;
}) {
  const { state } = part;
  const approvalId = (part as { approval?: { id: string } }).approval?.id;

  if (state === "output-available") {
    return (
      <div className={WIDTH_CLASS}>
        <Weather weatherAtLocation={part.output} />
      </div>
    );
  }

  if (isDenied(part)) {
    return (
      <div className={WIDTH_CLASS}>
        <Tool className="w-full" defaultOpen={true}>
          <ToolHeader state="output-denied" type="tool-getWeather" />
          <ToolContent>
            <div className="px-4 py-3 text-muted-foreground text-sm">
              Weather lookup was denied.
            </div>
          </ToolContent>
        </Tool>
      </div>
    );
  }

  if (state === "approval-responded") {
    return (
      <div className={WIDTH_CLASS}>
        <Tool className="w-full" defaultOpen={true}>
          <ToolHeader state={state} type="tool-getWeather" />
          <ToolContent>
            <ToolInput input={part.input} />
          </ToolContent>
        </Tool>
      </div>
    );
  }

  return (
    <div className={WIDTH_CLASS}>
      <Tool className="w-full" defaultOpen={true}>
        <ToolHeader state={state} type="tool-getWeather" />
        <ToolContent>
          {state === "input-available" || state === "approval-requested" ? (
            <ToolInput input={part.input} />
          ) : null}

          {state === "approval-requested" && approvalId ? (
            <ToolApprovalActions
              addToolApprovalResponse={addToolApprovalResponse}
              approvalId={approvalId}
            />
          ) : null}
        </ToolContent>
      </Tool>
    </div>
  );
}
