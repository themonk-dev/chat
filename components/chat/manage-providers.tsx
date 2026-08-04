"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConnectedProviders } from "@/hooks/use-connected-providers";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import {
  disconnectProvider,
  notifyConnectionsChanged,
} from "@/lib/oauth/connections";
import { PROVIDER_ORDER } from "@/lib/oauth/registry";
import { cn } from "@/lib/utils";
import { AuthDialog } from "./auth-dialog";
import { ChevronDownIcon } from "./icons";
import { ManageProvidersRow } from "./manage-providers-row";

/**
 * One popover listing every provider, each row connecting or disconnecting
 * independently of which one is active.
 *
 * Switching `activeId` to open the dialog is a means, not an end — every send
 * is addressed by it — so `previousActiveId` restores where the reader started
 * if they back out. `isConnected` is trustworthy for that because the target
 * always started disconnected, which is the only way its row offers Connect.
 */
export function ManageProviders() {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previousActiveId, setPreviousActiveId] = useState<
    string | undefined
  >();
  const { activeId, disconnect, isConnected, setActiveId } = useProviderAuth();

  /** The same map the chat side reads, so a disconnect here is one everywhere. */
  const connected = useConnectedProviders();

  // Opening is the one moment this list has to be right, and only storage can
  // tell: another tab's connect, or a token that expired, is invisible to state.
  useEffect(() => {
    if (open) {
      notifyConnectionsChanged();
    }
  }, [open]);

  const handleConnect = useCallback(
    (id: string) => {
      if (id === activeId) {
        setPreviousActiveId(undefined);
      } else {
        setPreviousActiveId(activeId);
        setActiveId(id);
      }

      setOpen(false);
      setDialogOpen(true);
    },
    [activeId, setActiveId]
  );

  useEffect(() => {
    if (dialogOpen || previousActiveId === undefined) {
      return;
    }

    if (!isConnected) {
      setActiveId(previousActiveId);
    }

    setPreviousActiveId(undefined);
  }, [dialogOpen, isConnected, previousActiveId, setActiveId]);

  /**
   * The active provider needs one extra step — clearing the hook's own
   * `tokens`/`isConnected`, which nothing outside it can reach.
   */
  const handleDisconnect = useCallback(
    (id: string) => {
      if (id === activeId) {
        disconnect();
      }

      disconnectProvider(id);
    },
    [activeId, disconnect]
  );

  const connectedCount = connected.size;

  return (
    <>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="gap-1.5 rounded-lg border-border/50 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:border-border/50 focus-visible:ring-0 active:translate-y-0"
            data-testid="manage-providers-trigger"
            size="sm"
            variant="outline"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                connectedCount > 0 ? "bg-emerald-500" : "bg-border"
              )}
            />
            {connectedCount > 0
              ? `${connectedCount} connected`
              : "Not connected"}
            <ChevronDownIcon />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-72 p-2">
          {/* Seven rows plus the note is about a short laptop window, so the
              list scrolls rather than the popover outgrowing the viewport. */}
          <div className="flex max-h-[min(60vh,22rem)] flex-col gap-0.5 overflow-y-auto">
            {PROVIDER_ORDER.map((id) => (
              <ManageProvidersRow
                connected={connected.has(id)}
                id={id}
                key={id}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>

          {/* Under the list rather than in the dialog: this is where the reader
              decides whether to hand over an account. */}
          <p className="mt-2 border-border/50 border-t px-2 pt-2 text-[11px] text-muted-foreground leading-relaxed">
            Tokens stay in this tab and are gone when you close it. Sign-in by{" "}
            <a
              className="underline underline-offset-2 transition-colors hover:text-foreground"
              href="https://ai-oauth.themonk.dev"
              rel="noopener noreferrer"
              target="_blank"
            >
              ai-oauth-sdk
            </a>
            .
          </p>
        </PopoverContent>
      </Popover>

      <AuthDialog
        key={activeId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}
