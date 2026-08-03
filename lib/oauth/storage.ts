import type { AuthClient } from "@ai-oauth-sdk/browser";
import {
  createBrowserAuthClient,
  publicClientIds,
  sessionStorageAdapter,
} from "@ai-oauth-sdk/browser";
import { proxiedProviders } from "./providers";

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
 */
const storage = sessionStorageAdapter();

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

export function clientFor(id: string): AuthClient {
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
    storage,
  });
  clients.set(id, client);

  return client;
}

export { storage as tokenStorage };
