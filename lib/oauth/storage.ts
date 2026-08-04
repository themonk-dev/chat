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
 * Tokens live in `sessionStorage`: they survive a reload and die with the tab.
 * Built on first use behind `assertBrowser`, because `sessionStorageAdapter()`
 * silently falls back to an in-memory `Map` — which on the server would be a
 * process-wide token store shared by every reader.
 */
function tokenStorage(): AuthStorage {
  assertBrowser("The provider token store");

  storage ??= sessionStorageAdapter();

  return storage;
}

/**
 * The published CLI client ids. OpenRouter has none — it identifies the app by
 * its callback URL and carries `requiresClientId: false`.
 */
const knownClientIds = publicClientIds as Record<string, string>;

const clients = new Map<string, AuthClient>();

/**
 * Guarded before the memo is consulted: `clients` is module scope too, so a
 * server-side hit would hand one reader another's client.
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
