"use client";

import type { TokenSet } from "@ai-oauth-sdk/browser";
import { manualReceiver, popupReceiver } from "@ai-oauth-sdk/browser";
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
import { registry } from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";

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

/**
 * Tokens, tagged with the id of the provider they were fetched or won for.
 *
 * A raw `TokenSet | undefined` cannot distinguish "these are Claude's
 * tokens" from "these are stale tokens a background flow handed us after
 * the reader moved to Claude" — both look like `TokenSet | undefined` to
 * the type system. Carrying `providerId` alongside `tokens` in one value
 * makes a mismatched pair something the reducer below refuses to expose,
 * rather than something every writer has to remember to check for: see
 * `tokens`/`isConnected` in the `value` memo, which only surface this pair
 * when `providerId` agrees with the current `activeId`.
 */
type TaggedTokens = { providerId: string; tokens: TokenSet | undefined };

/**
 * The paste flow's `manualReceiver` blocks on a `Promise<string>` that only
 * `submitCode` can settle — there is no other way to hand it the reader's
 * pasted value. `resolveInput` is that promise's `resolve`; `completion` is
 * the whole `client.login()` call `connect()` started in the background, so
 * `submitCode` can wait for the actual outcome (token written, or rejected)
 * instead of returning as soon as the paste is merely accepted.
 */
type PasteAttempt = {
  completion: Promise<void>;
  resolveInput: (value: string) => void;
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
  const [taggedTokens, setTaggedTokens] = useState<TaggedTokens>({
    providerId: "openrouter",
    tokens: undefined,
  });
  const [pending, setPending] = useState<PendingAuth | undefined>(undefined);

  /**
   * The `AbortController` for whichever `connect()` call is currently
   * in-flight for the device or popup flow, so `setActiveId` can cut it off
   * the moment the reader is no longer waiting on it (see `setActiveId`
   * below). `null` once that call has finished, one way or another.
   */
  const connectAbortRef = useRef<AbortController | null>(null);

  /** The paste flow's in-progress attempt, if any — see `PasteAttempt`. */
  const pasteAttemptRef = useRef<PasteAttempt | null>(null);

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

  /**
   * Switching away from whatever `connect()` is mid-flight for is exactly
   * the moment that attempt's result stops being wanted: cuts off its
   * `AbortController`, so a device poll or an open popup that finishes
   * after the reader has moved on does not keep running in the background.
   * `taggedTokens`' own pairing (see its type) is what keeps a result that
   * arrives anyway from landing in the wrong place — this only saves the
   * network activity, it is not what makes that safe.
   */
  const setActiveId = useCallback((id: string) => {
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    pasteAttemptRef.current = null;
    setActive(id);
    setPending(undefined);
    sessionStorage.setItem(ACTIVE_KEY, id);
  }, []);

  /**
   * `pending` must never outlive the attempt that set it: a device code that
   * gets denied or times out, or a popup the reader closes, has to leave the
   * dialog able to react rather than stuck showing a code that can no longer
   * be redeemed. Popup and device both resolve or fail within this call, so
   * `finally` clears `pending` unconditionally once either is done. Paste
   * clears it the same way, just from `completion`'s `finally` instead of
   * this function's own — see below.
   *
   * All three flows keep working after the reader backs out of the dialog —
   * a popup window left open, a device code approved later in another tab,
   * a paste flow still waiting on a `submitCode` that never comes — so all
   * three are given `controller.signal` to stop that work the moment
   * `setActiveId` decides it is no longer wanted. Once a result does arrive,
   * it is tagged with `result.provider` — the SDK's own record of which
   * provider actually issued it, not this call's closed-over `activeId` —
   * so a late result cannot silently masquerade as belonging to whatever is
   * active by the time it lands; see `taggedTokens`.
   *
   * Popup and paste both go through `clientFor(activeId).login()` rather
   * than the SDK's `loginWithPopup()` helper or a standalone
   * `createAuthorization()` + `completeAuthorization()` pair, deliberately:
   * a throwaway `AuthClient` built around the same shared storage still
   * caches `getTokens()` on its own instance after the first read, so its
   * `setTokens` (which `login()` calls on success) never reaches the
   * memoized instance `clientFor(id)` hands out everywhere else —
   * `manage-providers.tsx`'s connection dots, the model list — and that
   * instance would keep answering `undefined` forever after a real connect,
   * even with the token sitting in storage. Routing through the same
   * memoized client `deviceLogin` already used below makes it the single
   * writer for a provider's tokens, not just usually.
   */
  const connect = useCallback(async () => {
    const { flow } = registry[activeId];

    if (flow === "popup") {
      const client = clientFor(activeId);
      const controller = new AbortController();
      connectAbortRef.current = controller;

      try {
        const result = await client.login({
          receiver: popupReceiver(),
          signal: controller.signal,
        });
        setTaggedTokens({ providerId: result.provider, tokens: result });
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
        setTaggedTokens({ providerId: result.provider, tokens: result });
      } finally {
        setPending(undefined);
        if (connectAbortRef.current === controller) {
          connectAbortRef.current = null;
        }
      }

      return;
    }

    /**
     * `manualReceiver`'s `prompt` is called once `login()` has minted the
     * authorization URL and is ready to show it — this resolves
     * `promptShown` and parks `pending` at that point, rather than
     * `connect()` guessing the URL itself the way a standalone
     * `createAuthorization()` call used to. `prompt` returns `inputPromise`,
     * which only `submitCode` can settle: that is what makes `login()` wait
     * for the reader instead of the split `createAuthorization` +
     * `completeAuthorization` calls this used to be.
     *
     * `connect()` itself only awaits `promptShown` (raced against
     * `completion`, in case `login()` fails before ever reaching `prompt` —
     * a missing redirect URI, for instance), so it returns as soon as the
     * tab is open and the dialog has something to show, exactly like the
     * old `createAuthorization()` + `window.open()` pair did. The rest of
     * the flow — waiting for `submitCode`, exchanging the code, tagging and
     * writing the result — runs in `completion`, in the background, for
     * `submitCode` to await later.
     */
    const client = clientFor(activeId);
    const controller = new AbortController();
    connectAbortRef.current = controller;

    let resolveInput!: (value: string) => void;
    const inputPromise = new Promise<string>((resolve) => {
      resolveInput = resolve;
    });

    let signalPromptShown!: () => void;
    const promptShown = new Promise<void>((resolve) => {
      signalPromptShown = resolve;
    });

    const completion = client
      .login({
        openUrl: (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        },
        receiver: manualReceiver({
          prompt: (url) => {
            setPending({ kind: "paste", url });
            signalPromptShown();
            return inputPromise;
          },
        }),
        signal: controller.signal,
      })
      .then((result) => {
        setTaggedTokens({ providerId: result.provider, tokens: result });
      })
      .finally(() => {
        setPending(undefined);
        if (connectAbortRef.current === controller) {
          connectAbortRef.current = null;
        }
      });
    // Nothing awaits `completion` unless `submitCode` is called (the reader
    // may cancel before ever pasting anything) — one handler is enough to
    // keep a rejection from being reported as unhandled; `submitCode`, if
    // it runs, awaits `completion` itself and surfaces the same rejection.
    completion.catch(() => undefined);

    pasteAttemptRef.current = { completion, resolveInput };
    await Promise.race([promptShown, completion]);
  }, [activeId]);

  /**
   * Hands the reader's pasted value to whichever `manualReceiver` `prompt`
   * call from `connect()` is waiting on it — `resolveInput` — then waits for
   * `completion`, the same `client.login()` call `connect()` started, to
   * actually finish. `manualReceiver` accepts a full redirect URL, a bare
   * code, or Claude's `code#state` and does its own parsing (via the
   * provider's `parseCallback`), so nothing here re-implements that.
   *
   * A rejected code (expired, mistyped, already consumed) rejects
   * `completion` exactly like a network failure would, and propagates the
   * same way — the dialog's `.catch()` shows it. `pending` is cleared by
   * `completion`'s own `finally` in `connect()`, not here, since that is
   * the one place that already runs regardless of how the attempt ends.
   *
   * If there is no attempt in flight — the reader pasted something before
   * ever clicking "Open" — this throws rather than silently resolving,
   * which would otherwise read to the dialog as success and close it having
   * done nothing.
   */
  const submitCode = useCallback(async (code: string) => {
    const attempt = pasteAttemptRef.current;

    if (!attempt) {
      throw new Error(
        "Open the provider first, then paste the code it shows you."
      );
    }

    attempt.resolveInput(code.trim());
    await attempt.completion;
  }, []);

  const disconnect = useCallback(() => {
    setTaggedTokens({ providerId: activeId, tokens: undefined });
    setPending(undefined);
    clientFor(activeId)
      .logout()
      .catch(() => {
        // Local state is already cleared above; nothing left to do.
      });
  }, [activeId]);

  const tokens =
    taggedTokens.providerId === activeId ? taggedTokens.tokens : undefined;

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
