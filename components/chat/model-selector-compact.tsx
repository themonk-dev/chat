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
import { useProviderAuth } from "@/hooks/use-provider-auth";
import {
  type Model,
  type ModelGroup,
  modelsFor,
} from "@/lib/oauth/model-catalog";
import { registry } from "@/lib/oauth/registry";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./provider-mark";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const REFOCUS_DELAY_MS = 50;

/**
 * OpenRouter's listing is its whole catalogue — 338 models — and it sits second
 * in `PROVIDER_ORDER`, so unsliced it buries every provider after it under a
 * scroll nobody reaches. Browsing shows a slice per provider; searching, which
 * cmdk runs across every rendered row, shows all of them.
 */
const BROWSE_LIMIT = 8;

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
  groups: ModelGroup[],
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

/**
 * The selection is appended when the slice would have cut it: cmdk's default
 * highlight points at that row, and dropping it loses the highlight and the
 * tick beside the model the reader is actually on.
 */
function browseSlice(models: Model[], selectedModelId: string): Model[] {
  if (models.length <= BROWSE_LIMIT) {
    return models;
  }

  const shown = models.slice(0, BROWSE_LIMIT);

  if (!(selectedModelId && models.some((m) => m.id === selectedModelId))) {
    return shown;
  }

  const selected = shown.find((m) => m.id === selectedModelId);

  return selected
    ? shown
    : [...shown, models.find((m) => m.id === selectedModelId) as Model];
}

function PureModelSelectorCompact({
  groups,
  selectedModelId,
  onModelChange,
}: {
  /** Passed in, not fetched: the chat provider already holds one listing, and
   * a second fetch here could show rows the selection was never checked against. */
  groups: ModelGroup[];
  selectedModelId: string;
  onModelChange?: (modelId: string, providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { setActiveId } = useProviderAuth();
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
        <ModelSelectorInput
          onValueChange={setSearch}
          placeholder="Search models..."
          value={search}
        />
        <ModelSelectorList>
          {groups.length === 0 ? (
            <ModelSelectorEmpty>
              Connect a provider to see its models.
            </ModelSelectorEmpty>
          ) : (
            groups.map(({ providerId, models }) => {
              const shown = search
                ? models
                : browseSlice(models, selectedModelId);

              return (
                <ModelSelectorGroup
                  heading={registry[providerId].label}
                  key={providerId}
                >
                  {shown.map((model) => (
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

                  {shown.length < models.length ? (
                    // A plain node, not an item: cmdk would score it against
                    // the search and offer it as something to pick.
                    <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {models.length - shown.length} more — type to search
                    </p>
                  ) : null}
                </ModelSelectorGroup>
              );
            })
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

export const ModelSelectorCompact = memo(PureModelSelectorCompact);
