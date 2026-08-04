"use client";

import { ExternalLinkIcon, GithubIcon, PanelLeftIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DeployButton } from "./deploy-button";
import { ManageProviders } from "./manage-providers";

const REPOSITORY_URL = "https://github.com/themonk-dev/chat";

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

      <div className="ml-auto flex items-center gap-1.5">
        <a
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
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

        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild size="icon-sm" variant="ghost">
              <a
                aria-label="Source on GitHub"
                data-testid="repository-link"
                href={REPOSITORY_URL}
                rel="noopener noreferrer"
                target="_blank"
              >
                <GithubIcon className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Source on GitHub</TooltipContent>
        </Tooltip>

        <DeployButton />
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
