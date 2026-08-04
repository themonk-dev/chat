"use client";

import type { AuthClient, TokenSet } from "@ai-oauth-sdk/browser";
import { manualReceiver } from "@ai-oauth-sdk/browser";
import { useCallback, useEffect, useRef } from "react";
import type { AttemptWork } from "@/hooks/use-attempt-runner";
import {
  closeTab,
  openAuthorizationTab,
  type PasteAttempt,
  stateOfAuthorizationUrl,
  stateOfPastedValue,
} from "@/lib/oauth/auth-attempt";
import { registry } from "@/lib/oauth/registry";

/**
 * Enough to recognise the tab the reader still has open from a minute ago.
 * Anything older falls back to the SDK's own state comparison, which is the
 * actual security control.
 */
const REMEMBERED_SPENT_STATES = 8;

type PasteFlowOptions = {
  onTokens: (tokens: TokenSet) => void;
  runAttempt: <T>(
    work: AttemptWork<T>,
    controller?: AbortController
  ) => Promise<T>;
  setPending: (url: string) => void;
};

/**
 * Google's loopback flow, where the reader copies a URL out of a page that
 * failed to load. At most one attempt is live at a time.
 */
export function usePasteFlow({
  onTokens,
  runAttempt,
  setPending,
}: PasteFlowOptions) {
  const attemptRef = useRef<PasteAttempt | null>(null);
  const spentStatesRef = useRef<string[]>([]);

  /**
   * Dropping the ref was never enough: it left the attempt's own controller
   * unaborted whenever the runner's had moved on, and left its tab open with a
   * code nothing would accept.
   */
  const retire = useCallback(
    (attempt: PasteAttempt, options: { abort: boolean }) => {
      if (attemptRef.current === attempt) {
        attemptRef.current = null;
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

  const abandon = useCallback(() => {
    const attempt = attemptRef.current;

    if (attempt) {
      retire(attempt, { abort: true });
    }
  }, [retire]);

  useEffect(() => abandon, [abandon]);

  /**
   * Clicking "Open" again almost always means "I have lost that tab", not
   * "start over" — and `login()` mints a fresh `state` and PKCE verifier every
   * call, silently invalidating the tab the reader has usually already
   * consented in. So a live attempt is re-presented, never replaced.
   */
  const represent = useCallback(
    (live: PasteAttempt, providerId: string) => {
      if (live.tab && !live.tab.closed) {
        try {
          live.tab.focus();
        } catch {
          // A window we cannot focus is not a failed sign-in.
        }
      } else if (live.url) {
        live.tab = openAuthorizationTab(live.url, providerId);
      }

      if (live.url) {
        setPending(live.url);
      }
    },
    [setPending]
  );

  /**
   * Returns as soon as the tab is open and the dialog has something to show;
   * the rest runs in `completion`, for `submit` to await later.
   */
  const start = useCallback(
    async (client: AuthClient, providerId: string) => {
      const live = attemptRef.current;

      if (live) {
        represent(live, providerId);
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
        // Assigned below; the record has to exist first so `openUrl` and
        // `prompt` can write the tab and the state into it.
        completion: undefined as unknown as Promise<void>,
        controller: new AbortController(),
        resolveInput,
        state: undefined,
        tab: null,
        url: "",
      };

      attemptRef.current = attempt;

      attempt.completion = runAttempt(
        (signal, isCurrent) =>
          client
            .login({
              openUrl: (url) => {
                attempt.tab = openAuthorizationTab(url, providerId);
              },
              receiver: manualReceiver({
                prompt: (url) => {
                  attempt.state = stateOfAuthorizationUrl(url);
                  attempt.url = url;
                  setPending(url);
                  signalPromptShown();

                  return inputPromise;
                },
              }),
              signal,
            })
            .then((result) => {
              if (isCurrent()) {
                onTokens(result);
              }
            }),
        attempt.controller
      ).finally(() => {
        retire(attempt, { abort: false });
      });

      // Nothing awaits `completion` unless `submit` is called; one handler
      // keeps a rejection from being reported as unhandled.
      attempt.completion.catch(() => undefined);

      await Promise.race([promptShown, attempt.completion]);
    },
    [onTokens, represent, retire, runAttempt, setPending]
  );

  /**
   * The two checks are about *which* attempt the value belongs to: a code from
   * a finished attempt is dead, and left to the SDK that surfaces as "possible
   * CSRF" or a bare 429. Neither accepts anything the SDK would reject — they
   * only reject earlier, and with the reason.
   */
  const submit = useCallback(async (providerId: string, code: string) => {
    const value = code.trim();
    const pastedState = stateOfPastedValue(providerId, value);
    const attempt = attemptRef.current;
    const { label } = registry[providerId];
    const supersededMessage = `That code belongs to an earlier ${label} tab, which this sign-in has already finished with. Click "Open ${label}", then paste the code from the tab it opens.`;

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
  }, []);

  return { abandon, start, submit };
}
