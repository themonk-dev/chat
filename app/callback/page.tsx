"use client";

import { postCallbackToOpener } from "@ai-oauth-sdk/browser";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * The popup's redirect target. Its whole job is to hand the `?code=…` back to
 * the window that opened it and close itself.
 *
 * `postCallbackToOpener` posts to `window.location.origin` (never `*`) and the
 * opener drops any message whose `event.origin` is not its own, so the code
 * crosses the same-origin boundary and nowhere else. The effect runs only on
 * the client; during the static prerender this renders the spinner and
 * nothing more.
 *
 * If there is no opener — the URL was reached directly, or the popup was
 * reused as a tab — there is nothing to hand back, so we send the visitor
 * home.
 */
export default function CallbackPage() {
  const [stranded, setStranded] = useState(false);

  useEffect(() => {
    if (postCallbackToOpener()) {
      return;
    }

    setStranded(true);
    const timer = setTimeout(() => window.location.replace("/"), 1500);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <Spinner className="size-5" />
        <p className="text-muted-foreground text-sm">
          {stranded ? "Taking you back…" : "Completing sign-in…"}
        </p>
      </div>
    </div>
  );
}
