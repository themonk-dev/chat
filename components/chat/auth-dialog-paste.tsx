"use client";

import { ExternalLinkIcon } from "lucide-react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function AuthDialogPaste({
  busy,
  code,
  label,
  onCodeChange,
  onKeyDown,
  onOpen,
  onSubmit,
  pasteHint,
  tabOpen,
}: {
  busy: boolean;
  code: string;
  label: string;
  onCodeChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onOpen: () => void;
  onSubmit: () => void;
  pasteHint: string | undefined;
  tabOpen: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Button
        data-testid="auth-dialog-open"
        disabled={busy}
        onClick={onOpen}
        variant="outline"
      >
        {tabOpen ? `Reopen ${label}` : `Open ${label}`}
        <ExternalLinkIcon aria-hidden="true" className="size-4" />
      </Button>

      {pasteHint ? <DialogDescription>{pasteHint}</DialogDescription> : null}

      <Input
        data-testid="auth-dialog-paste-input"
        disabled={busy}
        onChange={onCodeChange}
        onKeyDown={onKeyDown}
        placeholder="Paste the code or URL here"
        value={code}
      />

      {/* The reader typically has an older callback tab open, and nothing on
          screen distinguished the two. */}
      {tabOpen ? (
        <DialogDescription data-testid="auth-dialog-paste-scope">
          Use the code from the {label} tab this dialog just opened — one from
          an earlier tab will not be accepted.
        </DialogDescription>
      ) : null}

      <Button
        data-testid="auth-dialog-submit"
        disabled={busy || !code.trim()}
        onClick={onSubmit}
      >
        Submit
      </Button>
    </div>
  );
}
