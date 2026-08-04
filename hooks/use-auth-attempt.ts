"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/oauth/auth-error-message";

type RunOptions = {
  /** Runs as soon as the attempt resolves, superseded or not. */
  onResolved?: () => void;
  /** Runs when this attempt is the newest and it failed. */
  onFailed?: () => void;
  /** The paste flow's Open button starts a flow rather than finishing one. */
  closeOnSuccess?: boolean;
};

/**
 * The bookkeeping every attempt in the auth dialog shares: a busy flag, the
 * error to show, and a sequence number so a superseded attempt cannot report
 * over the newest one or clear its spinner. Results landing after unmount are
 * dropped for the same reason.
 */
export function useAuthAttempt(onOpenChange: (open: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  // Re-armed in the effect body, not only at declaration: StrictMode's
  // development remount runs the cleanup once before the real mount.
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    (start: () => Promise<unknown>, options: RunOptions = {}) => {
      setError(undefined);
      setBusy(true);
      attemptRef.current += 1;

      const attemptId = attemptRef.current;
      const isCurrent = () =>
        mountedRef.current && attemptId === attemptRef.current;

      start()
        .then(() => {
          options.onResolved?.();

          if (isCurrent() && options.closeOnSuccess !== false) {
            onOpenChange(false);
          }
        })
        .catch((caught: unknown) => {
          if (!isCurrent()) {
            return;
          }

          setError(errorMessage(caught));
          options.onFailed?.();
        })
        .finally(() => {
          if (isCurrent()) {
            setBusy(false);
          }
        });
    },
    [onOpenChange]
  );

  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

  return { busy, clearError, error, run };
}
