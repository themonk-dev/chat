"use client";

import { useCallback } from "react";

export function ComposerEditBanner({ onCancel }: { onCancel: () => void }) {
  // `onMouseDown` rather than `onClick`: the textarea's blur would otherwise
  // fire first and move focus before the cancel lands.
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onCancel();
    },
    [onCancel]
  );

  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <span>Editing message</span>
      <button
        className="rounded px-1.5 py-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
        onMouseDown={handleMouseDown}
        type="button"
      >
        Cancel
      </button>
    </div>
  );
}
