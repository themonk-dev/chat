"use client";

import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { CopyIcon } from "./icons";

type DeviceCode = { userCode: string; verificationUri: string };

function WaitingNotice({
  label,
  verifying,
}: {
  label: string;
  verifying: boolean;
}) {
  // Nothing here can speak for a cross-origin popup, so an indeterminate
  // spinner is the only honest claim: the SDK is polling for approval.
  if (!verifying) {
    return (
      <DialogDescription>
        This dialog closes on its own once you approve the code, and the window
        you opened closes with it.
      </DialogDescription>
    );
  }

  return (
    <DialogDescription
      className="flex items-center gap-2"
      data-testid="device-waiting"
    >
      <Spinner className="size-4 shrink-0" />
      Waiting for you to approve the code in the {label} window. This dialog
      closes on its own when you do, and that window closes with it.
    </DialogDescription>
  );
}

export function AuthDialogDevice({
  hasError,
  label,
  onCopyCode,
  onOpenVerification,
  pending,
  verifying,
}: {
  hasError: boolean;
  label: string;
  onCopyCode: () => void;
  onOpenVerification: (event: MouseEvent<HTMLAnchorElement>) => void;
  pending: DeviceCode | undefined;
  verifying: boolean;
}) {
  if (!pending) {
    // Once an attempt has failed the error below explains it; repeating
    // "Requesting..." would misdescribe a request that already finished.
    return (
      <div className="flex flex-col gap-4">
        {hasError ? null : (
          <DialogDescription>
            Requesting a device code from {label}...
          </DialogDescription>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/40 px-4 py-4">
        <span
          className="flex-1 text-center font-mono text-3xl tracking-[0.35em]"
          data-testid="device-code"
        >
          {pending.userCode}
        </span>
        <Button
          className="shrink-0"
          onClick={onCopyCode}
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
          onClick={onOpenVerification}
          rel="noopener noreferrer"
          target="_blank"
        >
          {verifying ? "Reopen verification page" : "Open verification page"}
          <ExternalLinkIcon aria-hidden="true" className="size-4" />
        </a>
      </Button>

      <WaitingNotice label={label} verifying={verifying} />
    </div>
  );
}
