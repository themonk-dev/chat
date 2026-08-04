"use client";

import { postCallbackToOpener } from "@ai-oauth-sdk/browser";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { announceCallback } from "@/lib/oauth/popup-handshake";

/**
 * The popup's redirect target. Its whole job is to hand the `?code=…` back to
 * the window that opened it and close itself.
 *
 * Two routes, because one of them is not always there. `postCallbackToOpener`
 * posts to `window.location.origin` (never `*`) and the opener drops any
 * message whose `event.origin` is not its own — but a provider that sends an
 * enforced `Cross-Origin-Opener-Policy: same-origin`, as `claude.ai` does,
 * has already put this window in a browsing-context group of its own by the
 * time it gets here. `window.opener` is `null`, permanently, and the code has
 * no way home down that road.
 *
 * So it also announces itself on a `BroadcastChannel`, which is same-origin
 * by construction and does not care who opened whom. The waiting receiver
 * acknowledges, which is the one signal that distinguishes a severed popup —
 * opener gone, main window very much still waiting — from someone who reached
 * this URL by hand with nothing waiting anywhere. Only the second is stranded.
 */
type Outcome = "delivered" | "stranded" | "working";

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
        // Say so, rather than leaving the reader under a spinner that will
        // never resolve in a window nothing can shut.
        timer = setTimeout(() => setOutcome("delivered"), 500);

        return;
      }

      setOutcome("stranded");
      timer = setTimeout(() => window.location.replace("/"), 1500);
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
