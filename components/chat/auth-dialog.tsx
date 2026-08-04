"use client";

import { isOAuthError } from "@ai-oauth-sdk/browser";
import { ExternalLinkIcon } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useCopyToClipboard } from "usehooks-ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { openPopup } from "@/lib/oauth/popup-window";
import { currentOrigin, flowFor, registry } from "@/lib/oauth/registry";
import { CopyIcon } from "./icons";
import { providerLogos } from "./provider-logos";

/**
 * Said in full here, where the reader is about to hand over a credential and
 * the detail is worth the words. The empty-state card says the short version
 * inline instead of repeating this underneath itself.
 */
const PRIVACY_LINE =
  "Your token stays in this tab. It is never sent to our servers, and it is gone when you close this tab.";

/** A message this long, or one that looks like markup, is not fit to show. */
function unsafeToDisplay(text: string): boolean {
  return text.length > 160 || /<[a-z][^>]*>/i.test(text);
}

/**
 * `device_flow_failed` is the one error the SDK constructs by embedding a
 * truncated snippet of whatever the token endpoint actually returned
 * (`pollDeviceToken`'s `safeSnippet(text, 120)`) — ordinarily JSON, but a
 * gateway or proxy failure hands back its own HTML error page instead, and
 * that snippet is HTML markup. Every other `OAuthError` code the SDK raises
 * is built from a fixed, hand-written message, so this is the one place
 * that needs a template rather than the SDK's own text — an HTTP `status`,
 * when there is one, is always safe to show and more informative than
 * "something went wrong" on its own.
 *
 * `aborted` is its own case, checked before anything logs: it fires every
 * time `hooks/use-provider-auth.tsx`'s `setActiveId` cuts off an in-flight
 * attempt, which includes the ordinary, expected shape of a reader
 * cancelling — this dialog's own `key={activeId}` remount does not stop the
 * previous instance's `connect().catch()` from still running once that
 * happens. Treating it as a failure worth `console.error`-ing would turn
 * routine cancellation into console noise (and, in dev, a Next.js overlay)
 * on every single cancel.
 *
 * This one check is enough because `connect()` guarantees it is: cancellation
 * does not arrive here in whatever shape the abort happened to interrupt —
 * a bare `AbortError` `DOMException` from `fetch` when a device poll was on
 * the wire, an `OAuthError` when it was between polls — because
 * `use-provider-auth.tsx`'s `asCancellation` has already resolved that from
 * the `AbortController` it owns. Nothing here should ever go back to
 * classifying cancellation by inspecting the error; that is what let the
 * `DOMException` case through twice.
 *
 * Every other error still goes to `console.error` in full and is shown
 * verbatim unless it independently trips `unsafeToDisplay` — a defensive
 * backstop for any future code path this reasoning does not cover, not the
 * primary mechanism.
 */
function errorMessage(error: unknown): string {
  if (isOAuthError(error)) {
    if (error.code === "aborted") {
      return "Cancelled.";
    }

    console.error(error);

    if (error.code === "device_flow_failed") {
      return error.status
        ? `The provider had trouble completing this request (HTTP ${error.status}). Try again.`
        : "The provider had trouble completing this request. Try again.";
    }

    /**
     * The second templated code, for the same reason as the first: the SDK
     * builds this message by naming `provider.tokenUrl`, which for this app
     * is the proxy route (`/api/token/claude`) rather than anything a reader
     * has heard of, and then appends whatever the provider said.
     *
     * `429` gets its own sentence because it is the one the owner spent
     * hours on, and because the provider's own advice for it is actively
     * wrong. Claude's token endpoint answers `429 Rate limited. Please try
     * again later.` — verified live, on a single cold, well-formed request
     * carrying a code it did not like — so this is what a *rejected* code
     * looks like there, and "try again" immediately is what keeps the limit
     * hot. Say to wait, and say why.
     */
    if (error.code === "token_request_failed") {
      if (error.status === 429) {
        return "The provider is rate-limiting this code exchange. Wait a minute before trying again — repeated attempts keep the limit in place, and each one needs a fresh code.";
      }

      return error.status
        ? `The provider rejected this code (HTTP ${error.status}). Click Retry, then use the code from the tab that opens.`
        : "The provider rejected this code. Click Retry, then use the code from the tab that opens.";
    }

    return unsafeToDisplay(error.message)
      ? "Something went wrong. Please try again."
      : error.message;
  }

  if (error instanceof Error && error.message) {
    console.error(error);
    return unsafeToDisplay(error.message)
      ? "Something went wrong. Please try again."
      : error.message;
  }

  return "Something went wrong. Please try again.";
}

/**
 * The body of the dialog switches on `flowFor(activeId, …)`, because the flow
 * is what dictates the shape of the interaction, not a preference this
 * component gets to make. It asks the same function `connect()` asks rather
 * than reading the registry directly, so the body on screen and the flow
 * actually being run cannot disagree — which they would for Gemini, whose
 * flow depends on the origin.
 *
 * `connect()` and `submitCode()` throw on failure and clear `pending`
 * themselves, so every attempt below is wrapped in its own try/catch that
 * lands in `error` state — never left to reject unhandled, and never routed
 * through a toast, so closing the dialog mid-flow stays silent rather than
 * surfacing a notification for an attempt the reader already walked away
 * from.
 *
 * The caller remounts this component (`key={activeId}`) whenever the active
 * provider changes, so switching providers is a clean slate for free rather
 * than another effect to keep in sync.
 */
export function AuthDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { activeId, cancel, connect, pending, submitCode } = useProviderAuth();
  const { label, pasteHint } = registry[activeId];
  const flow = flowFor(activeId, currentOrigin());
  const Logo = providerLogos[activeId];

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [, copyToClipboard] = useCopyToClipboard();

  const attemptRef = useRef(0);
  const deviceStartedRef = useRef(false);

  /**
   * Whether the paste flow has a tab open that the reader is meant to be
   * pasting from.
   *
   * `pending` is exactly that fact and no other: `connect()` parks it when
   * `manualReceiver`'s `prompt` fires — which is after the authorization URL
   * exists and the tab has been opened — and `runAttempt`'s `finally` clears
   * it when the attempt ends, which is also when the hook retires the
   * attempt and closes the tab. So the two have the same lifetime, and this
   * needs no state of its own to fall out of sync with.
   */
  const pasteTabOpen = pending?.kind === "paste";

  /**
   * The provider window this dialog opened, so it can be closed again once
   * the poll comes back approved — the device flows' equivalent of what
   * OpenRouter's popup already does for itself (`postCallbackToOpener` ends
   * on `window.close()` because by then it is same-origin). It is a popup
   * rather than a tab; see `handleOpenVerification`.
   *
   * A window opened by `window.open` may be closed by its opener whatever
   * origin it has since navigated to; `close()` is one of the handful of
   * operations that survives the cross-origin boundary. Nothing else about
   * it is readable, so this cannot tell whether the reader wandered off to
   * another page in that tab — closing the tab we opened, once the thing we
   * opened it for is done, is the honest reading of that.
   */
  const verificationWindowRef = useRef<Window | null>(null);

  /**
   * Closes that window, if there is still one of ours to close.
   *
   * Every branch here is a real thing that happens, and none of them may
   * turn into a failure: the reader can approve the code on their phone and
   * never open a window at all (`null`), can close the tab themselves before
   * the poll notices (`closed`), and a handle can be severed by the
   * `Cross-Origin-Opener-Policy` the provider's own page sets, in which case
   * `close()` is a no-op or throws depending on the engine. The sign-in has
   * already succeeded by the time this runs, so nothing it does may be
   * allowed to unwind that — hence the swallow.
   */
  const closeVerificationWindow = useCallback(() => {
    const opened = verificationWindowRef.current;

    verificationWindowRef.current = null;
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

  /**
   * Opens the verification page as a popup, and keeps the handle.
   *
   * A popup rather than a tab, which is the change the owner asked for: a
   * tab takes the whole viewport, so the reader loses sight of the code they
   * are meant to be checking and of the dialog that is waiting on them, and
   * has to find their way back. The popup sits beside the app with both
   * visible, which is what OpenRouter's flow has always done —
   * `lib/oauth/popup-window.ts` is the same window, deliberately.
   *
   * `window.open` rather than letting the anchor navigate, because an anchor
   * hands back nothing to close later and no way to ask for a popup at all.
   * The `rel="noopener noreferrer"` the anchor still carries is not passed
   * here, and that is deliberate: `noopener` is precisely the feature that makes
   * `window.open` return `null` and makes the browser ignore both the window
   * name and the features, so there is no version of this that both severs
   * the opener and keeps a popup it can close. The page being opened is the
   * provider's own verification page, at a URL that came from that provider
   * over TLS.
   *
   * The name is per-provider and stable, so clicking again re-presents the
   * window that is already open instead of stacking a second one — the same
   * trade `use-provider-auth.tsx`'s `tabNameFor` makes for the paste flow.
   *
   * When there is no handle to be had — a popup blocker, a runtime that does
   * not implement `open` — the click is left alone and the anchor's own
   * `target="_blank"` does the navigating, exactly as it did before, and
   * nothing claims a window was opened. Losing the popup is fine; losing the
   * sign-in is not.
   */
  const handleOpenVerification = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      const opened = openPopup(
        event.currentTarget.href,
        `aioauth-verify-${activeId}`
      );

      if (!opened) {
        return;
      }

      event.preventDefault();
      verificationWindowRef.current = opened;
      setVerifying(true);

      try {
        opened.focus();
      } catch {
        // A window we cannot focus is not a failed sign-in.
      }
    },
    [activeId]
  );

  /**
   * Requests one device code. Guarded by `deviceStartedRef` so the mount
   * effect below and a reader clicking Retry can share this without ever
   * running two attempts at once — Retry's whole job is resetting that
   * guard first (see `handleRetry`) so this does not just no-op the second
   * time.
   */
  const startDevice = useCallback(() => {
    if (deviceStartedRef.current) {
      return;
    }

    deviceStartedRef.current = true;
    attemptRef.current += 1;
    const attemptId = attemptRef.current;
    setBusy(true);

    // A new request means a new code, which makes whatever is in an open
    // verification window unredeemable. Retry is the path that reaches this
    // with a window open; on the first request there is nothing to close.
    closeVerificationWindow();

    connect()
      .then(() => {
        closeVerificationWindow();

        if (attemptId === attemptRef.current) {
          onOpenChange(false);
        }
      })
      .catch((caught: unknown) => {
        if (attemptId === attemptRef.current) {
          setError(errorMessage(caught));
          deviceStartedRef.current = false;
        }
      })
      .finally(() => {
        if (attemptId === attemptRef.current) {
          setBusy(false);
        }
      });
  }, [closeVerificationWindow, connect, onOpenChange]);

  // Device is the one flow with no button to press: the code is only useful
  // once it exists, so the request goes out as soon as the dialog is open.
  useEffect(() => {
    if (!open) {
      return;
    }

    setError(undefined);

    if (flow === "device") {
      startDevice();
    }
  }, [flow, open, startDevice]);

  /**
   * Whether this dialog has an attempt of its own to clean up when it
   * closes — see the effect below for why that is a transition and not a
   * cleanup function.
   */
  const wasOpenRef = useRef(false);

  /**
   * Closing the dialog abandons the attempt it started.
   *
   * A device poll runs for the fifteen-minute life of its code, one request
   * every few seconds, and OpenAI's endpoint answers 403 until the code is
   * approved — so an abandoned one is a 403 loop against a provider's auth
   * endpoint with nothing left watching it. `setActiveId` used to be the
   * only thing that could stop an attempt, and it is only reached when the
   * dialog was opened for a provider other than the active one; the reader
   * connecting the provider they are already on never went near it.
   *
   * Written as an open-to-closed transition rather than as the mount
   * effect's cleanup on purpose. Cleanup also runs on every unmount —
   * including StrictMode's development remount, where it would abort the
   * attempt the mount had just started and force a second device-code
   * request per open. `deviceStartedRef` already makes that remount a
   * no-op; this keeps it one. Unmount-while-open is covered anyway: the
   * only ones are `activeId` changing (which is `setActiveId`, which
   * cancels) and `suggested-actions.tsx` swapping the notice out once
   * connected (by which point the attempt has settled).
   *
   * The guard is also reset here, so a reopened dialog starts a fresh
   * request rather than sitting on the "Requesting a device code..." line
   * forever.
   *
   * The verification window goes with it. `cancel()` abandons the attempt, so
   * the code in that window can no longer be redeemed by anything — leaving
   * it open is the dead window this task is about, one click further along.
   */
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }

    if (!wasOpenRef.current) {
      return;
    }

    wasOpenRef.current = false;
    deviceStartedRef.current = false;
    closeVerificationWindow();
    cancel();
  }, [cancel, closeVerificationWindow, open]);

  const handlePopupContinue = useCallback(() => {
    setError(undefined);
    setBusy(true);
    attemptRef.current += 1;
    const attemptId = attemptRef.current;

    connect()
      .then(() => {
        if (attemptId === attemptRef.current) {
          onOpenChange(false);
        }
      })
      .catch((caught: unknown) => {
        if (attemptId === attemptRef.current) {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (attemptId === attemptRef.current) {
          setBusy(false);
        }
      });
  }, [connect, onOpenChange]);

  const handleOpenPaste = useCallback(() => {
    setError(undefined);
    setBusy(true);

    connect()
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [connect]);

  const handleSubmitCode = useCallback(() => {
    if (!code.trim()) {
      return;
    }

    setError(undefined);
    setBusy(true);
    attemptRef.current += 1;
    const attemptId = attemptRef.current;

    submitCode(code)
      .then(() => {
        if (attemptId === attemptRef.current) {
          onOpenChange(false);
        }
      })
      .catch((caught: unknown) => {
        if (attemptId === attemptRef.current) {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (attemptId === attemptRef.current) {
          setBusy(false);
        }
      });
  }, [code, onOpenChange, submitCode]);

  const handleCodeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setCode(event.target.value);
    },
    []
  );

  const handlePasteKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleSubmitCode();
      }
    },
    [handleSubmitCode]
  );

  const handleCopyCode = useCallback(async () => {
    if (pending?.kind !== "device") {
      return;
    }
    await copyToClipboard(pending.userCode);
    toast.success("Code copied to clipboard!");
  }, [copyToClipboard, pending]);

  /**
   * A failed attempt should not be a dead end. What "retry" means depends
   * on the flow: popup and paste both already have a button that starts a
   * fresh attempt (`handlePopupContinue`, `handleOpenPaste`) — reusing them
   * here is what makes a stale or already-consumed code get replaced by a
   * new one rather than resubmitted. Device has no such button, because
   * normally nothing needs pressing; `startDevice` resets
   * `deviceStartedRef` itself before re-arming, so retrying here is not
   * silently swallowed by the guard that stops the mount effect from
   * double-firing.
   */
  const handleRetry = useCallback(() => {
    setError(undefined);

    if (flow === "device") {
      deviceStartedRef.current = false;
      startDevice();
      return;
    }

    if (flow === "popup") {
      handlePopupContinue();
      return;
    }

    setCode("");
    handleOpenPaste();
  }, [flow, handleOpenPaste, handlePopupContinue, startDevice]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex flex-row items-center gap-2">
            {Logo ? <Logo className="size-5 shrink-0" /> : null}
            Connect {label}
          </DialogTitle>
        </DialogHeader>

        {flow === "popup" ? (
          <div className="flex flex-col gap-4">
            <DialogDescription>
              {label} opens in a popup window. Sign in there and this dialog
              closes on its own once it is done.
            </DialogDescription>
            <Button
              data-testid="auth-dialog-continue"
              disabled={busy}
              onClick={handlePopupContinue}
            >
              {busy ? (
                <>
                  <Spinner className="size-4 shrink-0" />
                  Waiting for the popup...
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </div>
        ) : null}

        {flow === "device" ? (
          <div className="flex flex-col gap-4">
            {pending?.kind === "device" ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/40 px-4 py-4">
                  <span
                    className="flex-1 text-center font-mono text-3xl tracking-[0.35em]"
                    data-testid="device-code"
                  >
                    {pending.userCode}
                  </span>
                  <Button
                    className="shrink-0"
                    onClick={handleCopyCode}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <CopyIcon />
                  </Button>
                </div>
                <Button asChild variant="outline">
                  <a
                    data-testid="device-verification-link"
                    href={pending.verificationUri}
                    onClick={handleOpenVerification}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {verifying
                      ? "Reopen verification page"
                      : "Open verification page"}
                    <ExternalLinkIcon aria-hidden="true" className="size-4" />
                  </a>
                </Button>
                {/*
                  The loader, and the one honest thing it can say. Nothing
                  here can speak for what the provider's popup is doing — it
                  is cross-origin, and this page cannot see inside it — so a
                  progress bar would be invented. What is genuinely happening
                  is a poll: the SDK is asking the provider every few seconds
                  whether this code has been approved, from the moment the
                  code appears until it is approved, denied or expires. An
                  indeterminate spinner is exactly that claim and no more, and
                  it appears only once a window has actually been opened,
                  since before that the reader is the one being waited on.
                */}
                {verifying ? (
                  <DialogDescription
                    className="flex items-center gap-2"
                    data-testid="device-waiting"
                  >
                    <Spinner className="size-4 shrink-0" />
                    Waiting for you to approve the code in the {label} window.
                    This dialog closes on its own when you do, and that window
                    closes with it.
                  </DialogDescription>
                ) : (
                  <DialogDescription>
                    This dialog closes on its own once you approve the code, and
                    the window you opened closes with it.
                  </DialogDescription>
                )}
              </>
            ) : (
              // Once an attempt has failed, the error message below already
              // explains what happened — repeating "Requesting..." here
              // would misdescribe a request that already finished, badly.
              !error && (
                <DialogDescription>
                  Requesting a device code from {label}...
                </DialogDescription>
              )
            )}
          </div>
        ) : null}

        {flow === "paste" ? (
          <div className="flex flex-col gap-3">
            <Button
              data-testid="auth-dialog-open"
              disabled={busy}
              onClick={handleOpenPaste}
              variant="outline"
            >
              {pasteTabOpen ? `Reopen ${label}` : `Open ${label}`}
              <ExternalLinkIcon aria-hidden="true" className="size-4" />
            </Button>
            {pasteHint ? (
              <DialogDescription>{pasteHint}</DialogDescription>
            ) : null}
            <Input
              data-testid="auth-dialog-paste-input"
              disabled={busy}
              onChange={handleCodeChange}
              onKeyDown={handlePasteKeyDown}
              placeholder="Paste the code or URL here"
              value={code}
            />
            {/*
              Which tab the input belongs to, said out loud. The reader
              typically has an older callback tab open from a previous
              attempt, and nothing on screen distinguished the two — a code
              from the wrong one is refused by `submitCode`, but not being
              told which tab to use is how they got there.
            */}
            {pasteTabOpen ? (
              <DialogDescription data-testid="auth-dialog-paste-scope">
                Use the code from the {label} tab this dialog just opened — one
                from an earlier tab will not be accepted.
              </DialogDescription>
            ) : null}
            <Button
              data-testid="auth-dialog-submit"
              disabled={busy || !code.trim()}
              onClick={handleSubmitCode}
            >
              Submit
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="flex flex-col gap-3">
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
            <div className="flex flex-row gap-2">
              <Button
                className="flex-1"
                data-testid="auth-dialog-retry"
                onClick={handleRetry}
                variant="outline"
              >
                Retry
              </Button>
              <Button
                className="flex-1"
                data-testid="auth-dialog-close"
                onClick={handleClose}
                variant="ghost"
              >
                Close
              </Button>
            </div>
          </div>
        ) : null}

        <p className="border-border/50 border-t pt-4 text-muted-foreground text-xs">
          {PRIVACY_LINE}
        </p>
      </DialogContent>
    </Dialog>
  );
}
