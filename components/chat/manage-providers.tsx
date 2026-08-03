"use client";

import { LogOutIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";
import { cn } from "@/lib/utils";
import { AuthDialog } from "./auth-dialog";
import { ChevronDownIcon } from "./icons";
import { providerLogos } from "./provider-logos";

/** Snapshots which providers hold a token right now, straight from storage. */
async function fetchConnectedIds(): Promise<Set<string>> {
  const results = await Promise.all(
    PROVIDER_ORDER.map(async (id) => {
      const tokens = await clientFor(id)
        .getTokens()
        .catch(() => undefined);
      return [id, Boolean(tokens?.accessToken)] as const;
    })
  );

  return new Set(
    results.filter(([, connected]) => connected).map(([id]) => id)
  );
}

/**
 * Which providers already hold a token, independent of which one is active.
 *
 * `useProviderAuth` only tracks the active provider's connection, so the rest
 * are snapshotted straight from storage: once on mount, so the trigger's
 * count is accurate before the popover has ever been opened, and again every
 * time the popover opens, so a connect or disconnect that happened while it
 * was closed is reflected rather than assumed.
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

  const refresh = useCallback(() => {
    let cancelled = false;

    fetchConnectedIds().then((ids) => {
      if (!cancelled) {
        setConnectedIds(ids);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    if (open) {
      return refresh();
    }
  }, [open, refresh]);

  return [connectedIds, setConnectedIds] as const;
}

function ManageProvidersRow({
  connected,
  id,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  id: string;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const { label } = registry[id];
  const Logo = providerLogos[id];

  const handleConnect = useCallback(() => {
    onConnect(id);
  }, [id, onConnect]);

  const handleDisconnect = useCallback(() => {
    onDisconnect(id);
  }, [id, onDisconnect]);

  return (
    <div
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
      data-testid={`manage-providers-row-${id}`}
    >
      {Logo ? <Logo className="size-4 shrink-0" /> : null}
      <span className="flex-1 truncate text-sm">{label}</span>
      {connected ? (
        <>
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-emerald-500"
            />
            Connected
          </span>
          <Button
            aria-label={`Disconnect ${label}`}
            data-testid={`manage-providers-disconnect-${id}`}
            onClick={handleDisconnect}
            size="icon-sm"
            variant="ghost"
          >
            <LogOutIcon className="size-4" />
          </Button>
        </>
      ) : (
        <Button
          data-testid={`manage-providers-connect-${id}`}
          onClick={handleConnect}
          size="sm"
          variant="outline"
        >
          Connect
        </Button>
      )}
    </div>
  );
}

/**
 * Replaces the old provider dropdown + Authenticate button with a single
 * connection manager: one popover listing every provider, each row offering
 * to connect or disconnect independently of which provider is active.
 *
 * The active provider is special only because `useProviderAuth` and
 * `AuthDialog` are both scoped to it: disconnecting the active provider goes
 * through the hook's own `disconnect()` so its `isConnected` stays in sync
 * (calling storage directly would clear tokens while leaving that state
 * stale), and connecting a non-active provider first switches `activeId` so
 * `AuthDialog` — which always renders the active provider's flow — shows the
 * right one. The popover closes when the dialog opens so the two Radix
 * layers never fight over dismiss/focus handling.
 *
 * Switching `activeId` to open the dialog is a means, not an end: every chat
 * message goes out tagged with `activeId`, so a reader who opens Connect on
 * a provider they were merely curious about, then backs out, must land back
 * where they started — not on a provider they never asked to talk to, one
 * that may hold no token at all. `previousActiveId` remembers what to
 * restore, and the effect below decides whether to use it once the dialog
 * closes: `isConnected` at that moment is trustworthy for this precisely
 * because the target provider always started disconnected (that's the only
 * way its row offers `Connect`), so "still disconnected" and "cancelled or
 * failed" are the same fact. This deliberately reads `isConnected` rather
 * than trusting the dialog's own lifecycle, because `connect()` resolves for
 * the popup flow but only parks in `pending` for device and paste — the
 * dialog closing is not the same event as the connection succeeding.
 */
export function ManageProviders() {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previousActiveId, setPreviousActiveId] = useState<
    string | undefined
  >();
  const { activeId, disconnect, isConnected, setActiveId } = useProviderAuth();
  const [connectedIds, setConnectedIds] = useConnectedProviders(open);

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

  // Runs once the dialog closes, whichever way: on its own after a
  // successful `connect()`, or via Escape/backdrop/close-button while
  // `previousActiveId` still holds a provider to go back to. A successful
  // connection keeps the newly active provider active (plainly what the
  // reader wanted); anything else restores `previousActiveId`.
  useEffect(() => {
    if (dialogOpen || previousActiveId === undefined) {
      return;
    }

    if (!isConnected) {
      setActiveId(previousActiveId);
    }

    setPreviousActiveId(undefined);
  }, [dialogOpen, isConnected, previousActiveId, setActiveId]);

  const handleDisconnect = useCallback(
    (id: string) => {
      if (id === activeId) {
        disconnect();
        return;
      }

      setConnectedIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });

      clientFor(id)
        .logout()
        .catch(() => {
          // Local state is already cleared above; nothing left to do.
        });
    },
    [activeId, disconnect, setConnectedIds]
  );

  const connectedCount = connectedIds.size;

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
          {/*
           * Seven rows plus the note below is roughly the height of a short
           * laptop window, so the list scrolls rather than the popover growing
           * past the viewport and taking the note with it.
           */}
          <div className="flex max-h-[min(60vh,22rem)] flex-col gap-0.5 overflow-y-auto">
            {PROVIDER_ORDER.map((id) => (
              <ManageProvidersRow
                connected={connectedIds.has(id)}
                id={id}
                key={id}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>

          {/*
           * Sits under the list rather than in the dialog because this is where
           * the reader is deciding whether to hand over an account — the claim
           * is worth reading before the sign-in starts, not during it.
           */}
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
