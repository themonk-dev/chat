import type { ConnectedProviders } from "./connections";
import { defaultModelFor } from "./model-catalog";
import { PROVIDER_ORDER } from "./registry";

export type SelectionOutcome =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; modelId: string; providerId: string };

/**
 * Given who is connected and which provider the selection belongs to, decides
 * what should change. `PROVIDER_ORDER` is the fallback order so the picker
 * falls back to the same list the dropdown already shows.
 */
export function nextSelection({
  connected,
  currentModelId,
  owner,
}: {
  connected: ConnectedProviders;
  currentModelId: string;
  owner: string | undefined;
}): SelectionOutcome {
  const ownerStillConnected = owner !== undefined && connected.has(owner);

  if (currentModelId && ownerStillConnected) {
    return { kind: "keep" };
  }

  const fallback = PROVIDER_ORDER.find((id) => connected.has(id));

  if (fallback) {
    return {
      kind: "set",
      modelId: defaultModelFor(fallback),
      providerId: fallback,
    };
  }

  return currentModelId ? { kind: "clear" } : { kind: "keep" };
}

/** The three things one send is made of, and who they belong to. */
export type ResolvedRequest = {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * A send is addressed to the model's *owner*, not whichever provider is active
 * — `nextSelection` lets those diverge on purpose. Pairing the model with
 * `activeId` sends one provider's slug to another's API, billed to the wrong
 * account when the slug happens to exist there.
 *
 * The `activeAccessToken` fallback only covers the gap right after a connect,
 * and only when the owner is the active provider. An owner with no token yields
 * `undefined`, so the send fails closed rather than being re-pointed.
 */
export function resolveRequest({
  activeAccessToken,
  activeId,
  connected,
  modelId,
  owner,
}: {
  activeAccessToken: string | undefined;
  activeId: string;
  connected: ConnectedProviders;
  modelId: string;
  owner: string | undefined;
}): ResolvedRequest {
  const providerId = owner ?? activeId;

  return {
    accessToken:
      connected.get(providerId) ??
      (providerId === activeId ? activeAccessToken : undefined),
    modelId,
    providerId,
  };
}
