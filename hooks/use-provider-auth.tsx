"use client";

import type { TokenSet } from "@ai-oauth-sdk/browser";
import { loginWithPopup } from "@ai-oauth-sdk/browser";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { proxiedProviders } from "@/lib/oauth/providers";
import { registry } from "@/lib/oauth/registry";
import { clientFor, tokenStorage } from "@/lib/oauth/storage";

export type PendingAuth =
  | { kind: "device"; userCode: string; verificationUri: string }
  | { kind: "paste"; url: string };

type ProviderAuthValue = {
  activeId: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  pending: PendingAuth | undefined;
  setActiveId: (id: string) => void;
  submitCode: (code: string) => Promise<void>;
  tokens: TokenSet | undefined;
};

const ACTIVE_KEY = "ai-oauth-chat:provider";
const ProviderAuthContext = createContext<ProviderAuthValue | null>(null);

/**
 * Owns which provider is selected and whether it is connected.
 *
 * The three sign-in flows are not a preference — each provider's registered
 * client dictates which one is possible — so `connect()` branches on the
 * registry rather than on anything the reader chooses. Popup completes on its
 * own; device and paste both park in `pending` until the dialog drives them the
 * rest of the way.
 */
export function ProviderAuthProvider({ children }: { children: ReactNode }) {
  const [activeId, setActive] = useState("openrouter");
  const [tokens, setTokens] = useState<TokenSet | undefined>(undefined);
  const [pending, setPending] = useState<PendingAuth | undefined>(undefined);

  useEffect(() => {
    const stored = sessionStorage.getItem(ACTIVE_KEY);

    if (stored && registry[stored]) {
      setActive(stored);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    clientFor(activeId)
      .getTokens()
      .then((found) => {
        if (!cancelled) {
          setTokens(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokens(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const setActiveId = useCallback((id: string) => {
    setActive(id);
    setPending(undefined);
    sessionStorage.setItem(ACTIVE_KEY, id);
  }, []);

  /**
   * `pending` must never outlive the attempt that set it: a device code that
   * gets denied or times out, or a popup the reader closes, has to leave the
   * dialog able to react rather than stuck showing a code that can no longer
   * be redeemed. Popup and device both resolve or fail within this call, so
   * `finally` clears `pending` unconditionally once either is done — for
   * popup that is a no-op most of the time, but it is one line of insurance
   * against a stray value from whatever ran before.
   *
   * Paste is the exception: `setPending` here is not cleanup, it is the
   * successful outcome of this step — the flow is not over, it is handed to
   * `submitCode`. Only a failure to even get that far clears it, and the
   * error is rethrown rather than swallowed either way, so the caller (the
   * dialog) can show it instead of guessing from a reset `pending`.
   */
  const connect = useCallback(async () => {
    const { flow } = registry[activeId];
    const provider = proxiedProviders[activeId];

    if (flow === "popup") {
      try {
        const result = await loginWithPopup(provider, {
          storage: tokenStorage,
        });
        setTokens(result);
      } finally {
        setPending(undefined);
      }

      return;
    }

    if (flow === "device") {
      const client = clientFor(activeId);

      try {
        const result = await client.deviceLogin({
          onCode: (device) => {
            setPending({
              kind: "device",
              userCode: device.userCode,
              verificationUri:
                device.verificationUriComplete ?? device.verificationUri,
            });
          },
        });
        setTokens(result);
      } finally {
        setPending(undefined);
      }

      return;
    }

    const client = clientFor(activeId);

    try {
      const { url } = await client.createAuthorization();
      window.open(url, "_blank", "noopener,noreferrer");
      setPending({ kind: "paste", url });
    } catch (error) {
      setPending(undefined);
      throw error;
    }
  }, [activeId]);

  /**
   * Paste providers hand back either a bare code or the whole redirect URL the
   * browser could not load. Accept both by handing the raw input straight to
   * `completeAuthorization` as a `callbackUrl`: each provider's own
   * `parseCallback` already knows how to read its shape — Claude's bare
   * `code#state`, Gemini's unreachable `http://localhost/...` — so
   * re-implementing that parsing here would only be a second copy that can
   * drift from the SDK's.
   *
   * This is the flow's last step either way. A rejected code (expired,
   * mistyped, already consumed) ends the attempt exactly like success does, so
   * `pending` is cleared in `finally` regardless of outcome — the dialog is
   * not left stranded on a code that can never be resubmitted successfully —
   * and the error is left to propagate so the dialog can show it.
   */
  const submitCode = useCallback(
    async (code: string) => {
      try {
        const result = await clientFor(activeId).completeAuthorization({
          callbackUrl: code.trim(),
        });
        setTokens(result);
      } finally {
        setPending(undefined);
      }
    },
    [activeId]
  );

  const disconnect = useCallback(() => {
    setTokens(undefined);
    setPending(undefined);
    clientFor(activeId)
      .logout()
      .catch(() => {
        // Local state is already cleared above; nothing left to do.
      });
  }, [activeId]);

  const value = useMemo<ProviderAuthValue>(
    () => ({
      activeId,
      connect,
      disconnect,
      isConnected: Boolean(tokens?.accessToken),
      pending,
      setActiveId,
      submitCode,
      tokens,
    }),
    [activeId, connect, disconnect, pending, setActiveId, submitCode, tokens]
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
