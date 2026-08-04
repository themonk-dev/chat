"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import { getSelectionProviderId } from "@/hooks/use-active-chat";
import { useModelGroups } from "@/hooks/use-model-groups";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import { type Model, modelsFor } from "@/lib/oauth/model-catalog";
import { registry } from "@/lib/oauth/registry";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./provider-mark";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const REFOCUS_DELAY_MS = 50;

function setCookie(name: string, value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

/**
 * cmdk filters and tracks selection by this string, so it has to be unique per
 * row — providers do resell the same model under the same display name — while
 * still containing the text a reader would type to search.
 */
function itemValue(providerId: string, model: Model): string {
  return `${model.name} ${registry[providerId].label} ${providerId}:${model.id}`;
}

function ModelSelectorOption({
  model,
  onSelect,
  providerId,
  selected,
}: {
  model: Model;
  onSelect: (providerId: string, model: Model) => void;
  providerId: string;
  selected: boolean;
}) {
  const handleSelect = useCallback(() => {
    onSelect(providerId, model);
  }, [model, onSelect, providerId]);

  return (
    <ModelSelectorItem
      className={cn(
        // Every row carries the border so only its colour changes when the
        // choice moves; drawing it on one row would nudge the whole list.
        "flex w-full items-center gap-2 border border-transparent transition-colors",
        // `data-[selected]` is cmdk's keyboard cursor, not the chosen model.
        "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
        selected && "border-dashed border-foreground/50"
      )}
      onSelect={handleSelect}
      value={itemValue(providerId, model)}
    >
      <ProviderMark providerId={providerId} />
      <ModelSelectorName>{model.name}</ModelSelectorName>
    </ModelSelectorItem>
  );
}

/**
 * Resolved against the live listing, then the static catalogue, then the id
 * itself. Live-listing-only was a flake: only `activeId` is persisted, so the
 * selection is re-derived from the pinned catalogue, and a provider whose live
 * ids differ from the pinned ones blanked the label the moment its 200 landed.
 */
function selectedModelFor(
  groups: ReturnType<typeof useModelGroups>["groups"],
  providerId: string | undefined,
  modelId: string
): Model | undefined {
  if (!providerId) {
    return;
  }

  const live = groups.find((group) => group.providerId === providerId)?.models;

  return (
    live?.find((model) => model.id === modelId) ??
    modelsFor(providerId).find((model) => model.id === modelId) ??
    (modelId ? { id: modelId, name: modelId } : undefined)
  );
}

function PureModelSelectorCompact({
  connected,
  selectedModelId,
  onModelChange,
}: {
  connected: ConnectedProviders;
  selectedModelId: string;
  onModelChange?: (modelId: string, providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { setActiveId } = useProviderAuth();
  const { groups } = useModelGroups(connected);
  const refocusRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(
    () => () => {
      clearTimeout(refocusRef.current);
    },
    []
  );

  /**
   * The module-level mirror, not a local ref: `MultimodalInput` remounts on
   * `/` <-> `/chat/[id]` navigation while the chat context above it does not,
   * so a local ref lost the association while the selection was still live.
   */
  const selectedProviderId = getSelectionProviderId();
  const selectedModel = selectedModelFor(
    groups,
    selectedProviderId,
    selectedModelId
  );

  const handleSelect = useCallback(
    (providerId: string, model: Model) => {
      setActiveId(providerId);
      onModelChange?.(model.id, providerId);
      setCookie("chat-model", model.id);
      setOpen(false);

      clearTimeout(refocusRef.current);
      refocusRef.current = setTimeout(() => {
        document
          .querySelector<HTMLTextAreaElement>(
            "[data-testid='multimodal-input']"
          )
          ?.focus();
      }, REFOCUS_DELAY_MS);
    },
    [onModelChange, setActiveId]
  );

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid="model-selector"
          variant="ghost"
        >
          {selectedProviderId ? (
            <ProviderMark providerId={selectedProviderId} />
          ) : null}
          <ModelSelectorName>
            {selectedModel?.name ?? "Select a model"}
          </ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>

      <ModelSelectorContent
        commandDefaultValue={
          selectedProviderId && selectedModel
            ? itemValue(selectedProviderId, selectedModel)
            : undefined
        }
      >
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {groups.length === 0 ? (
            <ModelSelectorEmpty>
              Connect a provider to see its models.
            </ModelSelectorEmpty>
          ) : (
            groups.map(({ providerId, models }) => (
              <ModelSelectorGroup
                heading={registry[providerId].label}
                key={providerId}
              >
                {models.map((model) => (
                  <ModelSelectorOption
                    key={`${providerId}:${model.id}`}
                    model={model}
                    onSelect={handleSelect}
                    providerId={providerId}
                    selected={
                      providerId === selectedProviderId &&
                      model.id === selectedModelId
                    }
                  />
                ))}
              </ModelSelectorGroup>
            ))
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

export const ModelSelectorCompact = memo(PureModelSelectorCompact);
