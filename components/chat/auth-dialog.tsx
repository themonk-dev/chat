"use client";

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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthAttempt } from "@/hooks/use-auth-attempt";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { useVerificationWindow } from "@/hooks/use-verification-window";
import { currentOrigin, flowFor, registry } from "@/lib/oauth/registry";
import { AuthDialogDevice } from "./auth-dialog-device";
import { AuthDialogPaste } from "./auth-dialog-paste";
import { AuthDialogPopup } from "./auth-dialog-popup";
import { providerLogos } from "./provider-logos";

const PRIVACY_LINE =
  "Your token stays in this tab. It is never sent to our servers, and it is gone when you close this tab.";

/**
 * The body switches on `flowFor(activeId, …)` — the same function `connect()`
 * asks — so the body on screen and the flow being run cannot disagree, which
 * they would for Gemini, whose flow depends on the origin.
 *
 * The caller remounts this (`key={activeId}`) when the provider changes, so
 * switching is a clean slate rather than another effect to keep in sync.
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

  const [code, setCode] = useState("");
  const [, copyToClipboard] = useCopyToClipboard();
  const { busy, clearError, error, run } = useAuthAttempt(onOpenChange);
  const verification = useVerificationWindow(activeId);
  const deviceStartedRef = useRef(false);

  /**
   * `pending` is exactly "the paste flow has a tab open": `connect()` parks it
   * when the tab opens and `runAttempt` clears it when the attempt ends.
   */
  const pasteTabOpen = pending?.kind === "paste";

  const closeVerification = verification.close;

  /**
   * Guarded so the mount effect and Retry can share this; Retry's job is
   * resetting the guard first so this does not simply no-op.
   */
  const startDevice = useCallback(() => {
    if (deviceStartedRef.current) {
      return;
    }

    deviceStartedRef.current = true;

    // A new request means a new code, so whatever is in an open verification
    // window is no longer redeemable.
    closeVerification();

    run(connect, {
      onFailed: () => {
        deviceStartedRef.current = false;
      },
      onResolved: closeVerification,
    });
  }, [closeVerification, connect, run]);

  // Device is the one flow with no button to press: the code is only useful
  // once it exists, so the request goes out as soon as the dialog is open.
  useEffect(() => {
    if (!open) {
      return;
    }

    clearError();

    if (flow === "device") {
      startDevice();
    }
  }, [clearError, flow, open, startDevice]);

  const wasOpenRef = useRef(false);

  /**
   * Closing abandons the attempt: an abandoned device poll is a 403 loop
   * against a provider's auth endpoint with nothing watching it.
   *
   * Written as an open-to-closed transition rather than the mount effect's
   * cleanup, which also runs on StrictMode's development remount and would
   * force a second device-code request per open.
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
    closeVerification();
    cancel();
  }, [cancel, closeVerification, open]);

  const handlePopupContinue = useCallback(() => {
    run(connect);
  }, [connect, run]);

  const handleOpenPaste = useCallback(() => {
    run(connect, { closeOnSuccess: false });
  }, [connect, run]);

  const handleSubmitCode = useCallback(() => {
    if (!code.trim()) {
      return;
    }

    run(() => submitCode(code));
  }, [code, run, submitCode]);

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
   * Retry reuses each flow's own start button, which is what makes a stale code
   * get replaced rather than resubmitted.
   */
  const handleRetry = useCallback(() => {
    clearError();

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
  }, [clearError, flow, handleOpenPaste, handlePopupContinue, startDevice]);

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
          <AuthDialogPopup
            busy={busy}
            label={label}
            onContinue={handlePopupContinue}
          />
        ) : null}

        {flow === "device" ? (
          <AuthDialogDevice
            hasError={Boolean(error)}
            label={label}
            onCopyCode={handleCopyCode}
            onOpenVerification={verification.open}
            pending={pending?.kind === "device" ? pending : undefined}
            verifying={verification.verifying}
          />
        ) : null}

        {flow === "paste" ? (
          <AuthDialogPaste
            busy={busy}
            code={code}
            label={label}
            onCodeChange={handleCodeChange}
            onKeyDown={handlePasteKeyDown}
            onOpen={handleOpenPaste}
            onSubmit={handleSubmitCode}
            pasteHint={pasteHint}
            tabOpen={pasteTabOpen}
          />
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
