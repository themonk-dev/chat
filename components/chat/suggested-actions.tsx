"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { motion } from "framer-motion";
import { memo, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { suggestions } from "@/lib/constants";
import { registry } from "@/lib/oauth/registry";
import type { ChatMessage } from "@/lib/types";
import { Suggestion } from "../ai-elements/suggestion";
import { AuthDialog, PRIVACY_LINE } from "./auth-dialog";
import { providerLogos } from "./provider-logos";

type SuggestedActionsProps = {
  chatId: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
};

/**
 * Fills the empty-state region above the composer. While the selected
 * provider is disconnected, the four canned prompts would be actively
 * misleading — none of them can send — so this swaps them for an explanation
 * and a way to fix it instead. `key={activeId}` on the dialog and the
 * disconnected check both read straight from `useProviderAuth()`, so
 * switching providers in the dropdown updates this immediately, the same way
 * it does the header button.
 */
function PureSuggestedActions({ chatId, sendMessage }: SuggestedActionsProps) {
  const { activeId, isConnected } = useProviderAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const suggestedActions = suggestions;

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      window.history.pushState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendMessage({
        parts: [{ text: suggestion, type: "text" }],
        role: "user",
      });
    },
    [chatId, sendMessage]
  );

  const handleOpenDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);

  if (!isConnected) {
    const { label } = registry[activeId];
    const Logo = providerLogos[activeId];

    return (
      <>
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-start gap-3 rounded-xl border border-border/50 bg-card/30 px-4 py-4 sm:px-5 sm:py-5"
          data-testid="disconnected-notice"
          exit={{ opacity: 0, y: 16 }}
          initial={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="flex items-center gap-2 text-[13px] text-foreground leading-relaxed">
            {Logo ? <Logo className="size-4 shrink-0" /> : null}
            Connect {label} to start chatting — until you do, Send stays
            disabled and no request is made.
          </p>
          <Button
            className="rounded-lg"
            data-testid="disconnected-notice-connect"
            onClick={handleOpenDialog}
            size="sm"
          >
            Connect {label}
          </Button>
          <p className="text-[11px] text-muted-foreground">{PRIVACY_LINE}</p>
        </motion.div>
        <AuthDialog
          key={activeId}
          onOpenChange={setDialogOpen}
          open={dialogOpen}
        />
      </>
    );
  }

  return (
    <div
      className="flex w-full gap-2.5 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible"
      data-testid="suggested-actions"
      style={{
        msOverflowStyle: "none",
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {suggestedActions.map((suggestedAction, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="min-w-[200px] shrink-0 sm:min-w-0 sm:shrink"
          exit={{ opacity: 0, y: 16 }}
          initial={{ opacity: 0, y: 16 }}
          key={suggestedAction}
          transition={{
            delay: 0.06 * index,
            duration: 0.4,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <Suggestion
            className="h-auto w-full whitespace-nowrap rounded-xl border border-border/50 bg-card/30 px-4 py-3 text-left text-[12px] leading-relaxed text-muted-foreground transition-all duration-200 sm:whitespace-normal sm:p-4 sm:text-[13px] hover:-translate-y-0.5 hover:bg-card/60 hover:text-foreground hover:shadow-[var(--shadow-card)]"
            onClick={handleSuggestionClick}
            suggestion={suggestedAction}
          >
            {suggestedAction}
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(
  PureSuggestedActions,
  (prevProps, nextProps) => prevProps.chatId === nextProps.chatId
);
