"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConnectedProviders } from "@/lib/oauth/connections";
import {
  type Model,
  type ModelGroup,
  modelsFor,
} from "@/lib/oauth/model-catalog";
import { fetchModelsFor } from "@/lib/oauth/models";
import { PROVIDER_ORDER } from "@/lib/oauth/registry";

/**
 * Takes the connection map rather than calling `useConnectedProviders()` itself:
 * the composer already holds one for its send gate, and two instances mean two
 * storage sweeps describing the same fact — and two answers that can disagree.
 */
export function useModelGroups(connected: ConnectedProviders): {
  groups: ModelGroup[];
} {
  const [fetched, setFetched] = useState<Record<string, Model[]>>({});

  useEffect(() => {
    let cancelled = false;

    Promise.all(
      [...connected.entries()].map(
        async ([id, token]) => [id, await fetchModelsFor(id, token)] as const
      )
    ).then((results) => {
      if (!cancelled) {
        setFetched(Object.fromEntries(results));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connected]);

  const groups = useMemo(
    () =>
      PROVIDER_ORDER.filter((id) => connected.has(id)).map((id) => ({
        models: fetched[id] ?? modelsFor(id),
        providerId: id,
      })),
    [connected, fetched]
  );

  return { groups };
}
