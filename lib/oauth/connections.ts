import { clientFor } from "./storage";

/** Tokens for every provider that currently holds one, not just the active one. */
export type ConnectedProviders = Map<string, string>;

/**
 * Disconnecting a non-active provider changes neither `activeId` nor `tokens`,
 * so every connection map has to be told to re-read storage. The notification
 * carries nothing: each map asks storage itself.
 */
let connectionsRevision = 0;
const connectionsListeners = new Set<() => void>();

export function subscribeConnections(listener: () => void): () => void {
  connectionsListeners.add(listener);

  return () => {
    connectionsListeners.delete(listener);
  };
}

export function readConnectionsRevision(): number {
  return connectionsRevision;
}

export function notifyConnectionsChanged(): void {
  connectionsRevision += 1;

  for (const listener of connectionsListeners) {
    listener();
  }
}

/**
 * Refreshes after `logout()` settles and re-reads storage rather than assuming
 * it worked: a failed logout leaves the token in place.
 */
export function disconnectProvider(id: string): Promise<void> {
  return clientFor(id)
    .logout()
    .catch(() => undefined)
    .then(() => {
      notifyConnectionsChanged();
    });
}

/**
 * Returns `previous` untouched when nothing changed. Identity matters: the
 * model picker re-fetches every connected provider's listing whenever this map
 * changes, so a refresh that merely confirms must not look like news.
 */
export function withConnections(
  previous: ConnectedProviders,
  entries: readonly (readonly [string, string | undefined])[]
): ConnectedProviders {
  const next = new Map(previous);

  for (const [id, token] of entries) {
    if (token) {
      next.set(id, token);
    } else {
      next.delete(id);
    }
  }

  if (next.size !== previous.size) {
    return next;
  }

  for (const [id, token] of next) {
    if (previous.get(id) !== token) {
      return next;
    }
  }

  return previous;
}

/** The access token a provider currently holds, or nothing — never a throw. */
export function tokenFor(id: string): Promise<string | undefined> {
  return clientFor(id)
    .getTokens()
    .catch(() => undefined)
    .then((found) => found?.accessToken);
}
