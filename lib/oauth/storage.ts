import type { AuthClient, AuthStorage } from "@ai-oauth-sdk/browser";
import {
  createBrowserAuthClient,
  publicClientIds,
  sessionStorageAdapter,
} from "@ai-oauth-sdk/browser";
import { assertBrowser } from "./browser-only";
import { proxiedProviders } from "./providers";

let storage: AuthStorage | undefined;

/**
 * Tokens live in `sessionStorage`: they survive a reload, they are gone when the
 * tab closes, and they are never shared with another tab.
 *
 * Not memory, because the chat history beside them persists and an app that
 * signs you out on every refresh reads as broken. Not `localStorage`, because a
 * long-lived provider credential sitting there indefinitely is the thing this
 * playground exists to argue against.
 *
 * One storage instance across all providers: the SDK namespaces its keys by
 * provider id, so several can be connected at once without collision.
 *
 * Built on first use rather than at module scope, and behind `assertBrowser`.
 * `sessionStorageAdapter()` answers a missing `sessionStorage` with an
 * in-memory `Map` instead of an error, so evaluating this line on the server —
 * which SSR does, since this module is imported by `"use client"` code — used
 * to put a process-wide token store in the deployed lambda. It was empty only
 * because every caller happened to be inside an effect. Now the server has no
 * store to fill: nothing is constructed until someone asks, and on the server
 * nobody can.
 */
function tokenStorage(): AuthStorage {
  assertBrowser("The provider token store");

  storage ??= sessionStorageAdapter();

  return storage;
}

/**
 * The CLI client ids each vendor has published, keyed the same way the
 * descriptors are.
 *
 * Every built-in provider requires one — `AuthClient`'s constructor throws a
 * `configuration_error` immediately if `clientId` is absent and the descriptor
 * has not opted out — with the single exception of OpenRouter, which
 * identifies the app by its callback URL alone and carries `requiresClientId:
 * false`. `publicClientIds` has no OpenRouter entry for exactly that reason,
 * so the lookup below is `undefined` there and the constructor does not mind.
 */
const knownClientIds = publicClientIds as Record<string, string>;

const clients = new Map<string, AuthClient>();

/**
 * The memoized `AuthClient` for a provider.
 *
 * Guarded before the memo is even consulted, not merely before the storage is
 * built: `clients` is module scope too, so a server-side hit would be one
 * reader handed another's client. The check is first so that the error names
 * the real problem — a caller on the server — rather than whatever the next
 * line would have complained about.
 */
export function clientFor(id: string): AuthClient {
  assertBrowser("The provider auth client");

  const existing = clients.get(id);

  if (existing) {
    return existing;
  }

  const provider = proxiedProviders[id];

  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }

  const client = createBrowserAuthClient({
    clientId: knownClientIds[id],
    provider,
    storage: tokenStorage(),
  });
  clients.set(id, client);

  return client;
}
