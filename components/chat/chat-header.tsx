"use client";

import { ExternalLinkIcon, PanelLeftIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { ManageProviders } from "./manage-providers";

function PureChatHeader() {
  const { toggleSidebar } = useSidebar();

  return (
    <header className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3">
      <Button
        className="md:hidden"
        onClick={toggleSidebar}
        size="icon-sm"
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
      </Button>

      <ManageProviders />

      {/*
       * `ml-auto` rather than a spacer, so the byline stays pinned right while
       * the controls keep their natural widths on the left — the header has no
       * fixed columns to break.
       */}
      <a
        className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        href="https://themonk.dev"
        rel="noopener noreferrer"
        target="_blank"
      >
        built by{" "}
        <span className="inline-flex items-center gap-0.5 underline underline-offset-2">
          themonk.dev
          <ExternalLinkIcon className="size-3" />
        </span>
      </a>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
