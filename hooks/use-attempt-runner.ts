"use client";

import { useCallback, useEffect, useRef } from "react";
import { asCancellation } from "@/lib/oauth/auth-attempt";

export type AttemptWork<T> = (
  signal: AbortSignal,
  isCurrent: () => boolean
) => Promise<T>;

/**
 * Runs one sign-in attempt under its own controller and owns what is true of
 * every attempt, whichever flow it is: registering the controller so it can be
 * cut off, clearing `pending` however it settles, and turning every rejection
 * into one cancellation.
 *
 * Both are cleared only while still this attempt's, so a predecessor settling
 * late cannot blank what a newer attempt has already put on screen.
 *
 * `attemptSeq` is not bumped by `abort`: cancelling has never unwound a result
 * that lands anyway, and making it do so would lose a token the reader really
 * earned by closing the dialog a moment too early.
 */
export function useAttemptRunner(onSettled: () => void) {
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // An attempt left running keeps polling with nothing watching it.
  useEffect(() => abort, [abort]);

  const run = useCallback(
    <T>(
      work: AttemptWork<T>,
      controller: AbortController = new AbortController()
    ): Promise<T> => {
      seqRef.current += 1;

      const attemptId = seqRef.current;
      const isCurrent = () => seqRef.current === attemptId;

      controllerRef.current = controller;

      return work(controller.signal, isCurrent)
        .catch((error: unknown) => {
          throw asCancellation(controller, error);
        })
        .finally(() => {
          if (isCurrent()) {
            onSettled();
          }

          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        });
    },
    [onSettled]
  );

  return { abort, run };
}
