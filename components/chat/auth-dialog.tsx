"use client";

import { isOAuthError } from "@ai-oauth-sdk/browser";
import { ExternalLinkIcon } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
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
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { registry } from "@/lib/oauth/registry";
import { CopyIcon } from "./icons";
import { providerLogos } from "./provider-logos";

export const PRIVACY_LINE =
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
 * The body of the dialog switches on `registry[activeId].flow`, because the
 * flow is what dictates the shape of the interaction, not a preference this
 * component gets to make.
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
  const { activeId, connect, pending, submitCode } = useProviderAuth();
  const { flow, label, pasteHint } = registry[activeId];
  const Logo = providerLogos[activeId];

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [, copyToClipboard] = useCopyToClipboard();

  const attemptRef = useRef(0);
  const deviceStartedRef = useRef(false);

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

    connect()
      .then(() => {
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
  }, [connect, onOpenChange]);

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
              {busy ? "Waiting for the popup..." : "Continue"}
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
                    href={pending.verificationUri}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Open verification page
                    <ExternalLinkIcon aria-hidden="true" className="size-4" />
                  </a>
                </Button>
                <DialogDescription>
                  This dialog closes on its own once you approve the code.
                </DialogDescription>
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
            <Button disabled={busy} onClick={handleOpenPaste} variant="outline">
              Open {label}
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
