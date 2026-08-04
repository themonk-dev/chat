import type { ResolvedCredential, TokenSet } from "@ai-oauth-sdk/core";
import { proxiedProviders } from "./providers";

type CachedCopilotCredential = {
  credential: ResolvedCredential;
  expiresAt: number;
};

/** One exchange per `ghu_` token; see `copilotCredentialFor` for why. */
const copilotCredentials = new Map<string, CachedCopilotCredential>();

/** Renew this far ahead of the credential's real expiry, to absorb latency. */
const COPILOT_EXPIRY_SKEW_MS = 60_000;

/** A `ghu_` token GitHub never handed an expiry for is assumed valid this long. */
const COPILOT_DEFAULT_TTL_MS = 25 * 60 * 1000;

/**
 * The credential a `ghu_` GitHub token grants is not the one Copilot's API
 * accepts — that has to be exchanged for a short-lived Copilot token first,
 * which is what carries the descriptor's `Copilot-Integration-Id` header
 * alongside it. `exchangeCredential` does both and is read off the
 * descriptor rather than hardcoded, so a change to either lands here for
 * free.
 *
 * The exchange call itself goes straight to `api.github.com`, never through
 * our proxy, so the `ghu_` token travels only to GitHub — but that also
 * means it is the one round trip in this flow with no proxy caching or
 * retry logic backing it up, so it is cached here rather than repeated on
 * every message: the resulting token is valid for roughly 25 minutes, and
 * re-exchanging on every turn would multiply both latency and rate-limit
 * exposure on the path we control least.
 *
 * This lives in its own module rather than in `adapters.ts` because both
 * callers that need it — the chat adapter and the model listing — must use
 * the *same* cache, and `models.ts` importing `adapters.ts` would drag every
 * `@ai-sdk/*` provider package into the model picker's path for two headers
 * and a token.
 */
export async function copilotCredentialFor(
  accessToken: string
): Promise<ResolvedCredential> {
  const cached = copilotCredentials.get(accessToken);

  if (cached && Date.now() < cached.expiresAt - COPILOT_EXPIRY_SKEW_MS) {
    return cached.credential;
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
