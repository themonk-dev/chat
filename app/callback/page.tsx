"use client";

import { postCallbackToOpener } from "@ai-oauth-sdk/browser";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { announceCallback } from "@/lib/oauth/callback-channel";

/**
 * Hands the `?code=…` back and closes. Two routes because `window.opener` is
 * permanently `null` under an enforced COOP; the channel's acknowledgement is
 * what distinguishes a severed popup from someone who opened this URL by hand.
 */
type Outcome = "delivered" | "stranded" | "working";

const CLOSE_GRACE_MS = 500;
const STRAND_REDIRECT_MS = 1500;

const MESSAGES: Record<Outcome, string> = {
  delivered: "Signed in. You can close this window.",
  stranded: "Taking you back…",
  working: "Completing sign-in…",
};

export default function CallbackPage() {
  const [outcome, setOutcome] = useState<Outcome>("working");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const payload = window.location.search;

    if (postCallbackToOpener(payload)) {
      return;
    }

    announceCallback(payload).then((received) => {
      if (cancelled) {
        return;
      }

      if (received) {
        window.close();

        // A window the engine refuses to close is still a finished sign-in.
        timer = setTimeout(() => setOutcome("delivered"), CLOSE_GRACE_MS);

        return;
      }

      setOutcome("stranded");
      timer = setTimeout(
        () => window.location.replace("/"),
        STRAND_REDIRECT_MS
      );
    });

    return () => {
      cancelled = true;

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        {outcome === "delivered" ? null : <Spinner className="size-5" />}
        <p className="text-muted-foreground text-sm">{MESSAGES[outcome]}</p>
      </div>
    </div>
  );
}
