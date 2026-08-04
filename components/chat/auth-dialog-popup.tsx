"use client";

import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export function AuthDialogPopup({
  busy,
  label,
  onContinue,
}: {
  busy: boolean;
  label: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DialogDescription>
        {label} opens in a popup window. Sign in there and this dialog closes on
        its own once it is done.
      </DialogDescription>
      <Button
        data-testid="auth-dialog-continue"
        disabled={busy}
        onClick={onContinue}
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
  );
}
