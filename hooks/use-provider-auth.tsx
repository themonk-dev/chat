"use client";

import type { TokenSet } from "@ai-oauth-sdk/browser";
import {
  isOAuthError,
  manualReceiver,
  OAuthError,
  parseStandardCallback,
  popupReceiver,
} from "@ai-oauth-sdk/browser";
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
 * One paste attempt, and everything that belongs to it alone.
 *
 * The paste flow's `manualReceiver` blocks on a `Promise<string>` that only
 * `submitCode` can settle — there is no other way to hand it the reader's
 * pasted value. `resolveInput` is that promise's `resolve`; `completion` is
 * the whole `client.login()` call `connect()` started in the background, so
 * `submitCode` can wait for the actual outcome (token written, or rejected)
 * instead of returning as soon as the paste is merely accepted.
 *
 * The other three fields exist because an attempt is not just a promise —
 * it is a promise, a signal, an authorization and a tab, and all four have
 * to end together. `controller` is the attempt's own abort handle rather
 * than whatever `connectAbortRef` happens to hold, so abandoning *this*
 * attempt cannot depend on it still being the newest one. `state` is the
 * value this attempt's authorization URL carries, which is what makes a
 * pasted code attributable to an attempt at all. `tab` is the window
 * `openUrl` opened, so the attempt can put it back in front of the reader
 * and close it when it is done with it.
 *
 * `url` is kept for both: it is what `pending` shows, and it is what has to
 * be reopened if the reader closed the tab.
 */
type PasteAttempt = {
  completion: Promise<void>;
  controller: AbortController;
  resolveInput: (value: string) => void;
  state: string | undefined;
  tab: Window | null;
  url: string;
};

const ACTIVE_KEY = "ai-oauth-chat:provider";
const ProviderAuthContext = createContext<ProviderAuthValue | null>(null);

/**
 * How many finished authorizations to remember per provider, so a code from
 * one of them can be named rather than merely rejected.
 *
 * Small on purpose: this exists to recognise the tab the reader still has
 * open from a minute ago, not to keep a session-long ledger. Anything older
 * than the last few attempts falls back to the SDK's own state comparison,
 * which is the actual security control and rejects it either way.
 */
const REMEMBERED_SPENT_STATES = 8;

/**
 * The window name each provider's authorization tab is opened under.
 *
 * A stable name is what lets a second `window.open` reuse the tab that is
 * already there instead of stacking another one beside it — the reader ends
 * up with one Claude tab however many times they click, which is the point.
 */
function tabNameFor(providerId: string): string {
  return `aioauth-authorize-${providerId}`;
}

/**
 * Opens the provider's authorization page and keeps the handle.
 *
 * `noopener,noreferrer` is deliberately *not* passed, and it is worth being
 * explicit about the trade because the flags were there before. `noopener`
 * is precisely the feature that makes `window.open` return `null` and makes
 * the browser ignore the window name, so there is no version of this that
 * severs the opener and still lets the attempt find, focus and close its
 * own tab. `auth-dialog.tsx`'s `handleOpenVerification` already made this
 * exact trade for the device flow's verification page, for the same reason.
 *
 * What is bought with it is the two things this task is about: a second
 * click re-presents the tab that is already open rather than starting a
 * second authorization, and a finished attempt closes the tab it opened
 * rather than leaving a spent code on screen for the reader to paste again.
 * What is given up is that the provider's own page — claude.ai, Google's
 * consent screen, reached over TLS at a URL the SDK built — holds an
 * `opener` reference to this page.
 *
 * Returns `null` when there is no handle to be had (a popup blocker, a
 * runtime with no `open`). Everything downstream treats that as "no tab of
 * ours", which is the truth, and the flow still works: the reader can
 * always paste a code from a tab we do not hold.
 */
function openAuthorizationTab(url: string, providerId: string): Window | null {
  try {
    return window.open(url, tabNameFor(providerId));
  } catch {
    return null;
  }
}

/** The `state` an authorization URL carries, or nothing if it is unreadable. */
function stateOfAuthorizationUrl(url: string): string | undefined {
  let state: string | undefined;

  try {
    state = new URL(url).searchParams.get("state") ?? undefined;
  } catch {
    // An unparseable authorization URL is not something this can improve
    // on; the attempt simply has no state to attribute a paste to.
  }

  return state;
}

/**
 * The `state` a pasted value carries, read exactly the way the SDK will
 * read it moments later.
 *
 * Deliberately the provider's own `parseCallback` — Claude's `code#state`,
 * Gemini's whole loopback URL — rather than a second, nearly-right parser
 * that could disagree with the one that matters. Nothing is decided from
 * this beyond *which message the reader gets*: the SDK's own timing-safe
 * comparison inside `login()` is still what accepts or rejects the code,
 * and it runs regardless of what this returns.
 */
function stateOfPastedValue(
  providerId: string,
  value: string
): string | undefined {
  const parse =
    proxiedProviders[providerId]?.parseCallback ?? parseStandardCallback;

  let state: string | undefined;

  try {
    state = parse(value)?.state;
  } catch {
    // Nothing rides on this beyond the wording of a message. A value the
    // parser chokes on is left for the SDK to reject on its own terms.
  }

  return state;
}

/** Closes a tab this hook opened, if there is still one of ours to close. */
function closeTab(attempt: PasteAttempt): void {
  const { tab } = attempt;

  attempt.tab = null;

  if (!tab) {
    return;
  }

  try {
    if (!tab.closed) {
      tab.close();
    }
  } catch {
    // A window we cannot close is not a failed sign-in.
  }
}

/**
 * What a rejection from a cancelled attempt means, decided once.
 *
 * A cancelled attempt does not reject with one predictable thing, and no
 * caller can tell the shapes apart by inspection. `setActiveId` aborts the
 * signal every flow was handed, and whatever happens to be awaiting it at
 * that instant is what surfaces: the SDK's own `sleep` between device polls
 * raises `OAuthError("aborted")`, while a poll request already on the wire is
 * killed by `fetch` itself and raises a bare `DOMException` named
 * `AbortError` that never passes through SDK code at all. Which one a reader
 * gets is a matter of milliseconds. Call sites were left pattern-matching on
 * the error, so they recognised the first and reported the second as a
 * failure — a `console.error` and a dev-overlay issue for the ordinary act of
 * closing a dialog.
 *
 * `controller` is what actually knows, and it is not a shape: this hook
 * created it, `setActiveId` is the only thing that aborts it, so
 * `signal.aborted` is a direct record of "we cancelled this", true regardless
 * of what the abort happened to interrupt. Everything raised under it becomes
 * the SDK's own `aborted` error, so cancellation crosses this boundary as one
 * thing and callers have nothing left to guess at.
 *
 * Deliberately not a blanket catch: with `aborted` false — a device request
 * that genuinely fails, a dropped connection, a rejected code — the original
 * error is returned untouched and still reaches the dialog's error UI.
 */
function asCancellation(controller: AbortController, error: unknown): unknown {
  if (!controller.signal.aborted) {
    return error;
  }

  return isOAuthError(error) && error.code === "aborted"
    ? error
    : new OAuthError("aborted", "The sign-in was cancelled.");
}

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

  /**
   * The paste flow's in-progress attempt, if any — see `PasteAttempt`.
   *
   * At most one, and only while it is genuinely live. It used to outlive
   * itself: nothing cleared it when the attempt ended, so a second Submit
   * handed the reader's value to a `resolveInput` that had already settled
   * (a no-op) and then awaited the same settled `completion`, re-reporting
   * the first paste's error with nothing sent and nothing changed. Every
   * click of Submit after a failure did that, forever, and only Retry — the
   * one button that starts a new attempt — got out of it.
   */
  const pasteAttemptRef = useRef<PasteAttempt | null>(null);

  /**
   * States belonging to attempts that are over, newest last.
   *
   * The reader really does keep the provider's callback tab open, and the
   * code in it stops working the moment its attempt ends — the registry
   * consumed the `state`, and the provider will not honour a code twice.
   * Remembering the state lets `submitCode` say *that*, instead of letting
   * the SDK's CSRF wording (or, worse, a raw `HTTP 429` from an exchange
   * that should never have been attempted) stand in for it.
   */
  const spentStatesRef = useRef<string[]>([]);

  /**
   * Which attempt is the newest, counted across every flow.
   *
   * Two attempts against the *same* provider are the one case neither
   * existing guard can separate. `activeId` never moves, so comparing ids
   * sees agreement; the token's own `provider` tag says the right provider,
   * because it genuinely is that provider's token — see `taggedTokens`. The
   * thing that is stale is the attempt, and only the attempt's own identity
   * records that. `runAttempt` bumps this on every start and hands each
   * attempt an `isCurrent()` closed over its own number.
   *
   * Deliberately not bumped by `cancel()`. Cancelling has never unwound a
   * result that lands anyway (see `cancel`), and making it start doing so
   * would lose a token the reader really did earn if they closed the dialog
   * a moment too early. This is about supersession, which is a different
   * fact.
   */
  const attemptSeqRef = useRef(0);

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
   * Abandons whatever attempt is in flight, without changing provider.
   *
   * `setActiveId` used to be the only thing that did this, which quietly made
   * "the reader switched provider" the sole way an attempt could ever be
   * stopped. A device poll is a request every few seconds for the fifteen
   * minutes its code is valid — and OpenAI's device endpoint answers 403 for
   * "not approved yet", so an abandoned one is a 403 loop against a
   * provider's auth endpoint, which is how an origin earns a rate limit.
   * `manage-providers.tsx` only restores (and so only calls `setActiveId`)
   * when the dialog was opened for a *different* provider than the active
   * one; connecting the provider you are already on, or connecting from
   * `suggested-actions.tsx`'s disconnected notice, went through neither
   * path, so closing that dialog left the poll running with nothing left
   * able to stop it.
   *
   * Aborting is all this does to the *result*. It deliberately does not
   * touch `taggedTokens`: a result that lands anyway is already made safe by
   * that value's own provider pairing, and unwinding a token that genuinely
   * arrived would be a different, worse bug.
   *
   * A paste attempt is discarded through `retirePasteAttempt` rather than by
   * dropping the ref, because dropping the ref was never enough: it left the
   * attempt's own controller unaborted whenever `connectAbortRef` had moved
   * on, and left its tab open with a code in it that nothing would accept
   * any more.
   */
  const retirePasteAttempt = useCallback(
    (attempt: PasteAttempt, options: { abort: boolean }) => {
      if (pasteAttemptRef.current === attempt) {
        pasteAttemptRef.current = null;
      }

      if (options.abort) {
        attempt.controller.abort();
      }

      if (attempt.state) {
        const spent = [...spentStatesRef.current, attempt.state];

        spentStatesRef.current = spent.slice(-REMEMBERED_SPENT_STATES);
      }

      closeTab(attempt);
    },
    []
  );

  const cancel = useCallback(() => {
    const attempt = pasteAttemptRef.current;

    if (attempt) {
      retirePasteAttempt(attempt, { abort: true });
    }

    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    setPending(undefined);
  }, [retirePasteAttempt]);

  /**
   * Switching away from whatever `connect()` is mid-flight for is exactly
   * the moment that attempt's result stops being wanted: cuts off its
   * `AbortController`, so a device poll or an open popup that finishes
   * after the reader has moved on does not keep running in the background.
   * `taggedTokens`' own pairing (see its type) is what keeps a result that
   * arrives anyway from landing in the wrong place — this only saves the
   * network activity, it is not what makes that safe.
   */
  const setActiveId = useCallback(
    (id: string) => {
      cancel();
      setActive(id);
      sessionStorage.setItem(ACTIVE_KEY, id);
    },
    [cancel]
  );

  /**
   * Runs one sign-in attempt under its own `AbortController`, and owns
   * everything that is true of an attempt regardless of which flow it is.
   *
   * The three flows differ in what they call and how long they take, but not
   * in any of this: register the controller where `setActiveId` can reach it,
   * clear `pending` and that registration once the attempt settles however it
   * settles, and put every rejection through `asCancellation` on the way out.
   * Holding that in one function is what makes "was this abort ours?" a fact
   * the hook establishes once, rather than a question each flow — and each
   * caller downstream of it — answers again by inspecting an error.
   *
   * `pending` must never outlive the attempt that set it: a device code that
   * gets denied or times out, or a popup the reader closes, has to leave the
   * dialog able to react rather than stuck showing a code that can no longer
   * be redeemed. `finally` is what guarantees that, for all three.
   *
   * The registration is cleared only while it is still this attempt's. A
   * `connect()` that started later has already replaced it, and must not have
   * its own controller dropped — leaving it unabortable — by a predecessor
   * finishing late. `pending` is cleared on the same condition and for the
   * same reason: a predecessor settling late must not blank the code or URL
   * the newest attempt has already put on screen.
   *
   * `isCurrent` is handed to `work` so each flow can decide whether its
   * result is still wanted before writing it — see `attemptSeqRef` for the
   * case that needs it. The controller may be supplied by the caller when
   * the attempt has to hold its own (the paste flow does; see
   * `PasteAttempt`), and is otherwise this function's to make.
   */
  const runAttempt = useCallback(
    <T,>(
      work: (signal: AbortSignal, isCurrent: () => boolean) => Promise<T>,
      controller: AbortController = new AbortController()
    ): Promise<T> => {
      attemptSeqRef.current += 1;

      const attemptId = attemptSeqRef.current;
      const isCurrent = () => attemptSeqRef.current === attemptId;

      connectAbortRef.current = controller;

      return work(controller.signal, isCurrent)
        .catch((error: unknown) => {
          throw asCancellation(controller, error);
        })
        .finally(() => {
          if (isCurrent()) {
            setPending(undefined);
          }

          if (connectAbortRef.current === controller) {
            connectAbortRef.current = null;
          }
        });
    },
    []
  );

  /**
   * All three flows keep working after the reader backs out of the dialog —
   * a popup window left open, a device code approved later in another tab,
   * a paste flow still waiting on a `submitCode` that never comes — so all
   * three run through `runAttempt`, which hands them a signal that stops that
   * work the moment `setActiveId` decides it is no longer wanted, and turns
   * whatever the abort interrupts into one cancellation (see
   * `asCancellation`). Once a result does arrive,
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
    const client = clientFor(activeId);

    if (flow === "popup") {
      await runAttempt((signal, isCurrent) =>
        client
          .login({
            receiver: popupReceiver({
              redirectUri: `${window.location.origin}/callback`,
            }),
            signal,
          })
          .then((result) => {
            if (isCurrent()) {
              setTaggedTokens({ providerId: result.provider, tokens: result });
            }
          })
      );

      return;
    }

    if (flow === "device") {
      await runAttempt((signal, isCurrent) =>
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
              setTaggedTokens({ providerId: result.provider, tokens: result });
            }
          })
      );

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
     *
     * A second "Open {label}" while an attempt is live does *not* start
     * another one, and this is the crux of the bug. `login()` calls
     * `createAuthorization()`, which mints a fresh `state` and a fresh PKCE
     * verifier every time it is called — so a second attempt silently
     * invalidates the tab the reader is already looking at, and the code
     * they then paste fails the SDK's `state` comparison. Clicking again
     * almost always means "I have lost that tab", not "start over": they
     * have usually already consented in it. So the live attempt's tab is
     * put back in front of them and nothing new is minted.
     *
     * The attempt is only ever replaced when it is genuinely over — which
     * it now always is, because it retires itself below.
     */
    const live = pasteAttemptRef.current;

    if (live) {
      if (live.tab && !live.tab.closed) {
        try {
          live.tab.focus();
        } catch {
          // A window we cannot focus is not a failed sign-in.
        }
      } else if (live.url) {
        live.tab = openAuthorizationTab(live.url, activeId);
      }

      if (live.url) {
        setPending({ kind: "paste", url: live.url });
      }

      return;
    }

    let resolveInput!: (value: string) => void;
    const inputPromise = new Promise<string>((resolve) => {
      resolveInput = resolve;
    });

    let signalPromptShown!: () => void;
    const promptShown = new Promise<void>((resolve) => {
      signalPromptShown = resolve;
    });

    const attempt: PasteAttempt = {
      // Assigned on the next line; the record has to exist first so
      // `openUrl` and `prompt` can write the tab and the state into it.
      completion: undefined as unknown as Promise<void>,
      controller: new AbortController(),
      resolveInput,
      state: undefined,
      tab: null,
      url: "",
    };

    pasteAttemptRef.current = attempt;

    attempt.completion = runAttempt(
      (signal, isCurrent) =>
        client
          .login({
            openUrl: (url) => {
              attempt.tab = openAuthorizationTab(url, activeId);
            },
            receiver: manualReceiver({
              prompt: (url) => {
                attempt.state = stateOfAuthorizationUrl(url);
                attempt.url = url;
                setPending({ kind: "paste", url });
                signalPromptShown();
                return inputPromise;
              },
            }),
            signal,
          })
          .then((result) => {
            if (isCurrent()) {
              setTaggedTokens({ providerId: result.provider, tokens: result });
            }
          }),
      attempt.controller
    ).finally(() => {
      // However this ended, it is over: its `state` has been consumed, the
      // code in its tab is spent, and it is not something a later paste may
      // be handed to. Retiring it here is what makes "one live attempt"
      // true rather than aspirational.
      retirePasteAttempt(attempt, { abort: false });
    });

    // Nothing awaits `completion` unless `submitCode` is called (the reader
    // may cancel before ever pasting anything) — one handler is enough to
    // keep a rejection from being reported as unhandled; `submitCode`, if
    // it runs, awaits `completion` itself and surfaces the same rejection.
    attempt.completion.catch(() => undefined);

    await Promise.race([promptShown, attempt.completion]);
  }, [activeId, retirePasteAttempt, runAttempt]);

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
   *
   * The two checks before that are about *which* attempt the pasted value
   * belongs to, and they exist because the reader in practice has an older
   * callback tab still open. A code from a finished attempt, or from any
   * attempt other than the live one, is dead: its `state` has been consumed
   * and the provider will not honour the code twice. Left to the SDK, that
   * surfaces as "possible CSRF" — accurate about the mechanism and useless
   * about the cause — and, once the code did reach an exchange, as whatever
   * the provider answered, which for Claude is a bare `HTTP 429`.
   *
   * Neither check accepts anything the SDK would reject; both only reject
   * earlier, and with the reason. `login()`'s own timing-safe comparison
   * against the state it issued is still the control that decides, and it
   * runs on every value that gets past here.
   */
  const submitCode = useCallback(
    async (code: string) => {
      const value = code.trim();
      const pastedState = stateOfPastedValue(activeId, value);
      const attempt = pasteAttemptRef.current;
      const supersededMessage = `That code belongs to an earlier ${registry[activeId].label} tab, which this sign-in has already finished with. Click "Open ${registry[activeId].label}", then paste the code from the tab it opens.`;

      if (pastedState && spentStatesRef.current.includes(pastedState)) {
        throw new Error(supersededMessage);
      }

      if (!attempt) {
        throw new Error(
          "Open the provider first, then paste the code it shows you."
        );
      }

      if (pastedState && attempt.state && pastedState !== attempt.state) {
        throw new Error(supersededMessage);
      }

      attempt.resolveInput(value);
      await attempt.completion;
    },
    [activeId]
  );

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
