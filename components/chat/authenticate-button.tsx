"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { registry } from "@/lib/oauth/registry";
import { AuthDialog } from "./auth-dialog";
import { ChevronDownIcon } from "./icons";

export function AuthenticateButton() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { activeId, disconnect, isConnected } = useProviderAuth();
  const { label } = registry[activeId];

  const handleOpenDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);

  if (isConnected) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          asChild
          className="md:ml-auto data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          <Button
            className="gap-1.5 rounded-lg text-muted-foreground hover:text-foreground"
            data-testid="authenticate-button"
            size="sm"
            variant="ghost"
          >
            {label}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="disconnect-button"
            onSelect={disconnect}
            variant="destructive"
          >
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <Button
        className="rounded-lg bg-foreground px-4 text-background hover:bg-foreground/90 md:ml-auto"
        data-testid="authenticate-button"
        onClick={handleOpenDialog}
      >
        Authenticate
      </Button>
      <AuthDialog
        key={activeId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}
