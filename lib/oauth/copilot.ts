import type { ResolvedCredential, TokenSet } from "@ai-oauth-sdk/core";
import { BoundedMap } from "@/lib/bounded-map";
import { assertBrowser } from "./browser-only";
import { proxiedProviders } from "./providers";

type CachedCopilotCredential = {
  credential: ResolvedCredential;
  expiresAt: number;
};

/**
 * The key is the `ghu_` token, and a refresh rotates it — so an unbounded map
 * grows for the life of the tab while only the newest is ever read.
 */
const COPILOT_CACHE_LIMIT = 4;

/** One exchange per `ghu_` token; see `copilotCredentialFor` for why. */
const copilotCredentials = new BoundedMap<string, CachedCopilotCredential>(
  COPILOT_CACHE_LIMIT
);

/** Renew this far ahead of the credential's real expiry, to absorb latency. */
const COPILOT_EXPIRY_SKEW_MS = 60_000;

/** A `ghu_` token GitHub never handed an expiry for is assumed valid this long. */
const COPILOT_DEFAULT_TTL_MS = 25 * 60 * 1000;

/**
 * A `ghu_` token has to be exchanged for a short-lived Copilot credential
 * first. Cached because the exchange goes straight to `api.github.com` — the
 * one round trip with no proxy retry behind it — and lives in its own module so
 * the chat adapter and the model listing share one cache.
 *
 * Browser-only and asserted: on a server this map would be a process-wide store
 * of exchanged credentials, which is what this app tells readers does not exist.
 */
export async function copilotCredentialFor(
  accessToken: string
): Promise<ResolvedCredential> {
  assertBrowser("The Copilot credential exchange");

  const cached = copilotCredentials.get(accessToken);

  if (cached && Date.now() < cached.expiresAt - COPILOT_EXPIRY_SKEW_MS) {
    return cached.credential;
  }

  // Dropped rather than left to be overwritten, since the exchange below can
  // fail and a bounded map should not spend a slot on a dead entry.
  if (cached) {
    copilotCredentials.delete(accessToken);
  }

  const provider = proxiedProviders["github-copilot"];
  const tokens = {
    accessToken,
    provider: "github-copilot",
    raw: {},
    tokenType: "bearer",
  } as TokenSet;

  const credential = await provider.exchangeCredential?.(tokens, { fetch });

  if (!credential) {
    throw new Error(
      "The github-copilot descriptor has no credential exchange."
    );
  }

  copilotCredentials.set(accessToken, {
    credential,
    expiresAt: credential.expiresAt ?? Date.now() + COPILOT_DEFAULT_TTL_MS,
  });

  return credential;
}
