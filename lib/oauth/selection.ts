import type { ConnectedProviders } from "./connections";
import { defaultModelFor, type ModelGroup } from "./model-catalog";
import { PROVIDER_ORDER } from "./registry";

export type SelectionOutcome =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; modelId: string; providerId: string };

/** Empty until that provider's listing resolves, which is also the pre-fetch state. */
function listed(listings: ModelGroup[], providerId: string) {
  return (
    listings.find((group) => group.providerId === providerId)?.models ?? []
  );
}

/**
 * The catalogue default wins while it is still on offer — those are chosen, not
 * arbitrary (Flash before Pro on quota, Codex before GPT-5) — and only a listing
 * that has dropped it hands over to its own first entry.
 */
export function preferredModel(
  providerId: string,
  models: { id: string }[]
): string {
  const curated = defaultModelFor(providerId);

  if (models.length === 0 || models.some((model) => model.id === curated)) {
    return curated;
  }

  return models[0].id;
}

/**
 * Given who is connected, which provider the selection belongs to and what each
 * one currently lists, decides what should change. `PROVIDER_ORDER` is the
 * fallback order so the picker falls back to the same list the dropdown shows.
 *
 * `listings` arrives empty and refills when the live fetch lands, so a selection
 * seeded from the static catalogue is re-pointed once the provider says what it
 * actually offers.
 */
export function nextSelection({
  connected,
  currentModelId,
  listings = [],
  owner,
}: {
  connected: ConnectedProviders;
  currentModelId: string;
  listings?: ModelGroup[];
  owner: string | undefined;
}): SelectionOutcome {
  const ownerStillConnected = owner !== undefined && connected.has(owner);

  if (currentModelId && ownerStillConnected) {
    const offered = listed(listings, owner);

    // A model still on the list is the reader's own pick as often as ours, so
    // it is never second-guessed. Only one the provider dropped moves.
    if (offered.length === 0 || offered.some((m) => m.id === currentModelId)) {
      return { kind: "keep" };
    }

    return {
      kind: "set",
      modelId: preferredModel(owner, offered),
      providerId: owner,
    };
  }

  const fallback = PROVIDER_ORDER.find((id) => connected.has(id));

  if (fallback) {
    return {
      kind: "set",
      modelId: preferredModel(fallback, listed(listings, fallback)),
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
