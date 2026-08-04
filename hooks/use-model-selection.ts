"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import { nextSelection } from "@/lib/oauth/selection";

type Selection = { modelId: string; providerId: string | undefined };

/**
 * `ActiveChatProvider` does not remount on `/` <-> `/chat/[id]` navigation but
 * the picker below it does, so a component-local ref would lose the
 * model-to-provider association while the selection itself is still live.
 * `apply` below is the only writer of this and of the state beside it.
 */
let lastSelectionProviderId: string | undefined;

export function getSelectionProviderId(): string | undefined {
  return lastSelectionProviderId;
}

/**
 * Which model is selected and which provider it was picked from, as one value.
 * As two refs they moved differently — the id from an effect, the owner
 * synchronously — so between a selection changing and effects flushing the pair
 * described a model never picked from that provider.
 *
 * Starts empty rather than on a hard-coded model: with nothing connected, that
 * is the honest state. The recovery effect fills it as soon as a token is found.
 */
export function useModelSelection({
  activeId,
  connected,
  setActiveId,
}: {
  activeId: string;
  connected: ConnectedProviders;
  setActiveId: (id: string) => void;
}) {
  const [currentModelId, setCurrentModelId] = useState("");
  const selectionRef = useRef<Selection>({
    modelId: "",
    providerId: undefined,
  });

  const apply = useCallback(
    (modelId: string, providerId: string | undefined) => {
      selectionRef.current = { modelId, providerId };
      lastSelectionProviderId = providerId;
      setCurrentModelId(modelId);
    },
    []
  );

  /**
   * The picker passes `providerId` explicitly because selecting a model there
   * also switches the active provider: by the time this runs, `activeId` may
   * have moved on again if the reader clicked twice quickly.
   */
  const select = useCallback(
    (id: string, providerId?: string) => {
      apply(id, id ? (providerId ?? activeId) : undefined);
    },
    [activeId, apply]
  );

  /**
   * `"keep"` is the common case: merely looking at another provider must not
   * disturb a live selection. `"set"` also moves `activeId`, since a stale one
   * would send the new model's id to the old provider's API.
   */
  useEffect(() => {
    const outcome = nextSelection({
      connected,
      currentModelId,
      owner: selectionRef.current.providerId,
    });

    if (outcome.kind === "set") {
      apply(outcome.modelId, outcome.providerId);

      if (activeId !== outcome.providerId) {
        setActiveId(outcome.providerId);
      }

      return;
    }

    if (outcome.kind === "clear") {
      apply("", undefined);
    }
  }, [activeId, apply, connected, currentModelId, setActiveId]);

  return { currentModelId, select, selectionRef };
}
