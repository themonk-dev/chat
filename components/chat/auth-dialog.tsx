"use client";

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

const PRIVACY_LINE =
  "Your token stays in this tab. It is never sent to our servers, and it is gone when you close this tab.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [, copyToClipboard] = useCopyToClipboard();

  const attemptRef = useRef(0);
  const deviceStartedRef = useRef(false);

  // Device is the one flow with no button to press: the code is only useful
  // once it exists, so the request goes out as soon as the dialog is open.
  useEffect(() => {
    if (!open) {
      return;
    }

    setError(undefined);

    if (flow !== "device" || deviceStartedRef.current) {
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
  }, [connect, flow, onOpenChange, open]);

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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {label}</DialogTitle>
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
                <div className="flex items-center justify-between gap-2 rounded-xl border border-border/50 bg-muted/40 px-4 py-3 font-mono text-2xl tracking-[0.3em]">
                  <span data-testid="device-code">{pending.userCode}</span>
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
                    <ExternalLinkIcon className="size-4" />
                  </a>
                </Button>
                <DialogDescription>
                  This dialog closes on its own once you approve the code.
                </DialogDescription>
              </>
            ) : (
              <DialogDescription>
                Requesting a device code from {label}...
              </DialogDescription>
            )}
          </div>
        ) : null}

        {flow === "paste" ? (
          <div className="flex flex-col gap-3">
            <Button disabled={busy} onClick={handleOpenPaste} variant="outline">
              Open {label}
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
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <p className="border-border/50 border-t pt-4 text-muted-foreground text-xs">
          {PRIVACY_LINE}
        </p>
      </DialogContent>
    </Dialog>
  );
}
