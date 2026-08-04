"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import {
  type ConnectedProviders,
  readConnectionsRevision,
  subscribeConnections,
  tokenFor,
  withConnections,
} from "@/lib/oauth/connections";
import { PROVIDER_ORDER } from "@/lib/oauth/registry";

export type { ConnectedProviders } from "@/lib/oauth/connections";

/** One frozen empty map, so every mount starts on the same identity. */
const NONE: ConnectedProviders = new Map();

/**
 * Which providers hold a token, independent of which one is active — the
 * question `useProviderAuth` cannot answer, since its `tokens` are scoped to
 * `activeId`. The sweep runs on mount because the send gate, the model picker
 * and the recovery effect all ask before the reader touches anything.
 */
export function useConnectedProviders(): ConnectedProviders {
  const { activeId, tokens } = useProviderAuth();
  const [connected, setConnected] = useState<ConnectedProviders>(NONE);
  const revision = useSyncExternalStore(
    subscribeConnections,
    readConnectionsRevision,
    readConnectionsRevision
  );

  /**
   * Re-reads storage for `activeId` rather than trusting `tokens`, which lags
   * it by a commit — trusting it files the previous provider's token under the
   * new id. `tokens` stays a dependency purely as a trigger.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokens is a trigger-only dependency, not read in the body
  useEffect(() => {
    let cancelled = false;
    const id = activeId;

    tokenFor(id).then((accessToken) => {
      if (cancelled) {
        return;
      }

      setConnected((previous) =>
        withConnections(previous, [[id, accessToken]])
      );
    });

    return () => {
      cancelled = true;
    };
  }, [activeId, tokens]);

  /** The full sweep: a revocation elsewhere can concern any provider. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger-only dependency; the answer always comes from storage
  useEffect(() => {
    let cancelled = false;

    Promise.all(
      PROVIDER_ORDER.map(
        async (id) => [id, await tokenFor(id)] as [string, string | undefined]
      )
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setConnected((previous) => withConnections(previous, results));
    });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return connected;
}
