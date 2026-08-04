"use client";

import { type MouseEvent, useCallback, useRef, useState } from "react";
import { openPopup } from "@/lib/oauth/popup-window";

/**
 * The device flows' verification page, opened as a popup so it sits beside the
 * dialog the reader is being waited on by — the same window OpenRouter's
 * receiver opens.
 *
 * `noopener` is deliberately not passed: it is what makes `window.open` return
 * `null` and the browser ignore the name and features, so there is no version
 * of this that severs the opener and keeps a window it can close. When there is
 * no handle to be had the click is left alone and the anchor navigates.
 */
export function useVerificationWindow(providerId: string) {
  const [verifying, setVerifying] = useState(false);
  const windowRef = useRef<Window | null>(null);

  /**
   * The sign-in has already succeeded by the time this runs, so nothing it does
   * may unwind that: a missing, already-closed or COOP-severed handle is fine.
   */
  const close = useCallback(() => {
    const opened = windowRef.current;

    windowRef.current = null;
    setVerifying(false);

    if (!opened) {
      return;
    }

    try {
      if (!opened.closed) {
        opened.close();
      }
    } catch {
      // A window we cannot close is not a failed sign-in.
    }
  }, []);

  const open = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      const opened = openPopup(
        event.currentTarget.href,
        `aioauth-verify-${providerId}`
      );

      if (!opened) {
        return;
      }

      event.preventDefault();
      windowRef.current = opened;
      setVerifying(true);

      try {
        opened.focus();
      } catch {
        // A window we cannot focus is not a failed sign-in.
      }
    },
    [providerId]
  );

  return { close, open, verifying };
}
