"use client";

import { LogOutIcon } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { registry } from "@/lib/oauth/registry";
import { providerLogos } from "./provider-logos";

export function ManageProvidersRow({
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
