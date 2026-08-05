"use client";

import type { AuthClient, TokenSet } from "@ai-oauth-sdk/browser";
import { popupReceiver } from "@ai-oauth-sdk/browser";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAttemptRunner } from "@/hooks/use-attempt-runner";
import { usePasteFlow } from "@/hooks/use-paste-flow";
import { tabNameFor } from "@/lib/oauth/auth-attempt";
import { handshakePopupReceiver } from "@/lib/oauth/popup-handshake";
import {
  currentOrigin,
  DEFAULT_PROVIDER_ID,
  flowFor,
  registry,
  SEVERING_AUTH_PAGES,
} from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";

export type PendingAuth =
  | { kind: "device"; userCode: string; verificationUri: string }
  | { kind: "paste"; url: string };

type ProviderAuthValue = {
  activeId: string;
  cancel: () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  pending: PendingAuth | undefined;
  setActiveId: (id: string) => void;
  submitCode: (code: string) => Promise<void>;
  tokens: TokenSet | undefined;
};

/**
 * Tokens tagged with the provider they were won for. A bare `TokenSet` cannot
 * distinguish "Claude's tokens" from "stale tokens a background flow handed us
 * after the reader moved to Claude"; the pair is only exposed when it agrees
 * with `activeId`.
 */
type TaggedTokens = { providerId: string; tokens: TokenSet | undefined };

const ACTIVE_KEY = "ai-oauth-chat:provider";
const ProviderAuthContext = createContext<ProviderAuthValue | null>(null);

/**
 * Owns which provider is selected and whether it is connected. The flow is not
 * a preference — each provider's registered client dictates it — so `connect()`
 * branches on `flowFor(activeId)` and on the origin, for the one provider whose
 * client permits more on loopback than in production.
 */
export function ProviderAuthProvider({ children }: { children: ReactNode }) {
  const [activeId, setActive] = useState(DEFAULT_PROVIDER_ID);
  const [taggedTokens, setTaggedTokens] = useState<TaggedTokens>({
    providerId: DEFAULT_PROVIDER_ID,
    tokens: undefined,
  });
  const [pending, setPending] = useState<PendingAuth | undefined>(undefined);

  useEffect(() => {
    const stored = sessionStorage.getItem(ACTIVE_KEY);

    if (stored && registry[stored]) {
      setActive(stored);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = activeId;

    clientFor(id)
      .getTokens()
      .then((found) => {
        if (!cancelled) {
          setTaggedTokens({ providerId: id, tokens: found });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTaggedTokens({ providerId: id, tokens: undefined });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const clearPending = useCallback(() => {
    setPending(undefined);
  }, []);

  const { abort, run } = useAttemptRunner(clearPending);

  /**
   * Tagged with `result.provider` — the SDK's own record of who issued it —
   * never this call's closed-over `activeId`, so a late result cannot
   * masquerade as belonging to whatever is active by the time it lands.
   */
  const acceptTokens = useCallback((result: TokenSet) => {
    setTaggedTokens({ providerId: result.provider, tokens: result });
  }, []);

  const showPasteUrl = useCallback((url: string) => {
    setPending({ kind: "paste", url });
  }, []);

  const {
    abandon: abandonPaste,
    start: startPaste,
    submit: submitPastedCode,
  } = usePasteFlow({
    onTokens: acceptTokens,
    runAttempt: run,
    setPending: showPasteUrl,
  });

  /**
   * Abandons whatever is in flight without changing provider. A device poll is
   * a request every few seconds for fifteen minutes, and OpenAI's endpoint
   * answers 403 until approval — an abandoned one is how an origin earns a rate
   * limit. Deliberately does not touch `taggedTokens`: a result that lands
   * anyway is already made safe by that value's own pairing.
   */
  const cancel = useCallback(() => {
    abandonPaste();
    abort();
    setPending(undefined);
  }, [abandonPaste, abort]);

  const setActiveId = useCallback(
    (id: string) => {
      cancel();
      setActive(id);
      sessionStorage.setItem(ACTIVE_KEY, id);
    },
    [cancel]
  );

  /**
   * A provider whose authorization page sends an enforced COOP header severs
   * the popup, taking `window.opener` and a truthful `.closed` with it.
   */
  const connectWithPopup = useCallback(
    (client: AuthClient, providerId: string) => {
      const redirectUri = `${window.location.origin}/callback`;
      const receiver = SEVERING_AUTH_PAGES.has(providerId)
        ? handshakePopupReceiver({
            redirectUri,
            windowName: tabNameFor(providerId),
          })
        : popupReceiver({ redirectUri });

      return run((signal, isCurrent) =>
        client.login({ receiver, signal }).then((result) => {
          if (isCurrent()) {
            acceptTokens(result);
          }
        })
      );
    },
    [acceptTokens, run]
  );

  const connectWithDevice = useCallback(
    (client: AuthClient) =>
      run((signal, isCurrent) =>
        client
          .deviceLogin({
            onCode: (device) => {
              setPending({
                kind: "device",
                userCode: device.userCode,
                verificationUri:
                  device.verificationUriComplete ?? device.verificationUri,
              });
            },
            signal,
          })
          .then((result) => {
            if (isCurrent()) {
              acceptTokens(result);
            }
          })
      ),
    [acceptTokens, run]
  );

  /**
   * Popup and paste both go through `clientFor(activeId).login()` rather than a
   * throwaway client: a second `AuthClient` caches `getTokens()` on its own
   * instance, so its `setTokens` never reaches the memoized one everything else
   * reads, and that instance would answer `undefined` forever after a connect.
   */
  const connect = useCallback(async () => {
    const flow = flowFor(activeId, currentOrigin());
    const client = clientFor(activeId);

    if (flow === "popup") {
      await connectWithPopup(client, activeId);
      return;
    }

    if (flow === "device") {
      await connectWithDevice(client);
      return;
    }

    await startPaste(client, activeId);
  }, [activeId, connectWithDevice, connectWithPopup, startPaste]);

  const submitCode = useCallback(
    (code: string) => submitPastedCode(activeId, code),
    [activeId, submitPastedCode]
  );

  const disconnect = useCallback(() => {
    setTaggedTokens({ providerId: activeId, tokens: undefined });
    setPending(undefined);
    clientFor(activeId)
      .logout()
      .catch(() => undefined);
  }, [activeId]);

  const tokens =
    taggedTokens.providerId === activeId ? taggedTokens.tokens : undefined;

  const value = useMemo<ProviderAuthValue>(
    () => ({
      activeId,
      cancel,
      connect,
      disconnect,
      isConnected: Boolean(tokens?.accessToken),
      pending,
      setActiveId,
      submitCode,
      tokens,
    }),
    [
      activeId,
      cancel,
      connect,
      disconnect,
      pending,
      setActiveId,
      submitCode,
      tokens,
    ]
  );

  return (
    <ProviderAuthContext.Provider value={value}>
      {children}
    </ProviderAuthContext.Provider>
  );
}

export function useProviderAuth() {
  const context = useContext(ProviderAuthContext);

  if (!context) {
    throw new Error("useProviderAuth must be used within ProviderAuthProvider");
  }

  return context;
}
