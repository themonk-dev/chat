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
  useRef,
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

  /**
   * Mirrors `activeId` for `connect()`'s own late-arriving continuations.
   *
   * Device polling has no deadline shorter than the RFC 8628 code's own
   * expiry (minutes), and a popup's promise only settles when the user
   * finishes there or closes it. Both keep running after the reader backs
   * out of the dialog and `activeId` moves on, so by the time either
   * resolves, the `activeId` closed over at the start of `connect()` may no
   * longer be current. Reading this ref instead — updated by the effect
   * below on every commit, not by the async work itself — is what lets the
   * guard in `connect()` tell "this is still the flow I started" from "the
   * reader moved on; do not let a foreign token land in active state."
   */
  const activeIdRef = useRef(activeId);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /**
   * The `AbortController` for whichever `connect()` call is currently
   * in-flight for the device or popup flow, so `setActiveId` can cut it off
   * the moment the reader is no longer waiting on it (see `setActiveId`
   * below). `null` once that call has finished, one way or another.
   */
  const connectAbortRef = useRef<AbortController | null>(null);

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

  /**
   * Switching away from whatever `connect()` is mid-flight for is exactly
   * the moment that attempt's result stops being wanted: cuts off its
   * `AbortController` first, so a device poll or an open popup that
   * finishes after the reader has moved on does not resolve into anything.
   * `connect()`'s own guard (see below) is the backstop for the sliver of
   * time between the signal firing and the underlying request noticing it.
   */
  const setActiveId = useCallback((id: string) => {
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
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
   *
   * Popup and device both keep working after the reader backs out of the
   * dialog — a popup window left open, a device code the reader approves
   * later in another tab — so both are given `controller.signal` to stop
   * that work the moment `setActiveId` decides it is no longer wanted, and
   * both check `activeIdRef` before writing the result into active state as
   * a second, independent guard against whatever a signal cannot cut off in
   * time (a response already in flight when it fires). Neither matters for
   * paste: `createAuthorization` returns immediately, so there is nothing
   * left running in the background for `setActiveId` to race against.
   */
  const connect = useCallback(async () => {
    const attemptId = activeId;
    const { flow } = registry[activeId];
    const provider = proxiedProviders[activeId];

    if (flow === "popup") {
      const controller = new AbortController();
      connectAbortRef.current = controller;

      try {
        const result = await loginWithPopup(provider, {
          signal: controller.signal,
          storage: tokenStorage,
        });
        if (activeIdRef.current === attemptId) {
          setTokens(result);
        }
      } finally {
        setPending(undefined);
        if (connectAbortRef.current === controller) {
          connectAbortRef.current = null;
        }
      }

      return;
    }

    if (flow === "device") {
      const client = clientFor(activeId);
      const controller = new AbortController();
      connectAbortRef.current = controller;

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
          signal: controller.signal,
        });
        if (activeIdRef.current === attemptId) {
          setTokens(result);
        }
      } finally {
        setPending(undefined);
        if (connectAbortRef.current === controller) {
          connectAbortRef.current = null;
        }
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
   *
   * The request this makes is short, but not instant, and the dialog does
   * not block Escape while it is in flight — so, like `connect()`, this
   * checks `activeIdRef` before writing the result into active state, in
   * case the reader backed out and a restore moved `activeId` on while this
   * was still on the wire.
   */
  const submitCode = useCallback(
    async (code: string) => {
      const attemptId = activeId;

      try {
        const result = await clientFor(activeId).completeAuthorization({
          callbackUrl: code.trim(),
        });
        if (activeIdRef.current === attemptId) {
          setTokens(result);
        }
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
