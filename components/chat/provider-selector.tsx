"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";
import { cn } from "@/lib/utils";
import { CheckCircleFillIcon, ChevronDownIcon } from "./icons";

/**
 * Which providers already hold a token, independent of which one is active.
 *
 * `useProviderAuth` only tracks the active provider's connection, so the rest
 * are snapshotted straight from storage each time the menu opens — cheap, and
 * fresh enough for a list the reader is about to look at anyway.
 */
function useConnectedProviders(open: boolean) {
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const { activeId, isConnected } = useProviderAuth();

  useEffect(() => {
    setConnectedIds((previous) => {
      const next = new Set(previous);
      if (isConnected) {
        next.add(activeId);
      } else {
        next.delete(activeId);
      }
      return next;
    });
  }, [activeId, isConnected]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    Promise.all(
      PROVIDER_ORDER.map(async (id) => {
        const tokens = await clientFor(id)
          .getTokens()
          .catch(() => undefined);
        return [id, Boolean(tokens?.accessToken)] as const;
      })
    ).then((results) => {
      if (!cancelled) {
        setConnectedIds(
          new Set(
            results.filter(([, connected]) => connected).map(([id]) => id)
          )
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  return connectedIds;
}

function ProviderSelectorItem({
  connected,
  id,
  isActive,
  onSelect,
}: {
  connected: boolean;
  id: string;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  return (
    <DropdownMenuItem
      className="group/item flex flex-row items-center justify-between gap-4"
      data-active={isActive}
      data-testid={`provider-selector-item-${id}`}
      onSelect={handleSelect}
    >
      <div className="flex flex-row items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connected ? "bg-emerald-500" : "bg-border"
          )}
        />
        {registry[id].label}
      </div>
      <div className="text-foreground opacity-0 group-data-[active=true]/item:opacity-100 dark:text-foreground">
        <CheckCircleFillIcon />
      </div>
    </DropdownMenuItem>
  );
}

export function ProviderSelector({
  className,
}: React.ComponentProps<typeof Button>) {
  const [open, setOpen] = useState(false);
  const { activeId, setActiveId } = useProviderAuth();
  const connectedIds = useConnectedProviders(open);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        asChild
        className={cn(
          "w-fit data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
          className
        )}
      >
        <Button
          className="gap-1.5 rounded-lg border-border/50 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:border-border/50 focus-visible:ring-0 active:translate-y-0"
          data-testid="provider-selector"
          size="sm"
          variant="outline"
        >
          {registry[activeId].label}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[260px]">
        {PROVIDER_ORDER.map((id) => (
          <ProviderSelectorItem
            connected={connectedIds.has(id)}
            id={id}
            isActive={id === activeId}
            key={id}
            onSelect={setActiveId}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
