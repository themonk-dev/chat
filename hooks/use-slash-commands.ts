"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";
import { toast } from "sonner";
import {
  type SlashCommand,
  slashCommands,
} from "@/components/chat/slash-commands";
import { deleteChat, listChats } from "@/lib/chats/store";

type SlashCommandsOptions = {
  chatId: string;
  clearChat: () => void;
  setInput: (value: string) => void;
};

function matching(query: string): SlashCommand[] {
  return slashCommands.filter((command) =>
    command.name.startsWith(query.toLowerCase())
  );
}

/**
 * The composer's `/command` menu: which commands match what has been typed,
 * where the keyboard cursor is, and what each command does.
 */
export function useSlashCommands({
  chatId,
  clearChat,
  setInput,
}: SlashCommandsOptions) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const confirmDelete = useCallback(() => {
    toast("Delete this chat?", {
      action: {
        label: "Delete",
        onClick: () => {
          deleteChat(chatId);
          router.push("/");
          toast.success("Chat deleted");
        },
      },
    });
  }, [chatId, router]);

  const confirmPurge = useCallback(() => {
    toast("Delete all chats?", {
      action: {
        label: "Delete all",
        onClick: () => {
          for (const chat of listChats()) {
            deleteChat(chat.id);
          }

          router.push("/");
          toast.success("All chats deleted");
        },
      },
    });
  }, [router]);

  const select = useCallback(
    (command: SlashCommand) => {
      setOpen(false);
      setInput("");

      switch (command.action) {
        case "new":
          router.push("/");
          break;

        case "clear":
          clearChat();
          break;

        case "rename":
          toast("Rename is available from the sidebar chat menu.");
          break;

        case "model":
          document
            .querySelector<HTMLButtonElement>("[data-testid='model-selector']")
            ?.click();
          break;

        case "theme":
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          break;

        case "delete":
          confirmDelete();
          break;

        case "purge":
          confirmPurge();
          break;

        default:
          break;
      }
    },
    [
      clearChat,
      confirmDelete,
      confirmPurge,
      resolvedTheme,
      router,
      setInput,
      setTheme,
    ]
  );

  /** Opens while the whole value is one unbroken `/word`. */
  const trackInput = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = event.target;

    if (value.startsWith("/") && !value.includes(" ")) {
      setOpen(true);
      setQuery(value.slice(1));
      setIndex(0);
      return;
    }

    setOpen(false);
  }, []);

  /** Returns whether the key was consumed by the menu. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) {
        return false;
      }

      const filtered = matching(query);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((current) => Math.min(current + 1, filtered.length - 1));
        return true;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((current) => Math.max(current - 1, 0));
        return true;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();

        if (filtered[index]) {
          select(filtered[index]);
        }

        return true;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return true;
      }

      return false;
    },
    [index, open, query, select]
  );

  /** A whole-input command (`/theme` then Enter), submitted rather than picked. */
  const submitTyped = useCallback(
    (value: string): boolean => {
      if (!value.startsWith("/")) {
        return false;
      }

      const command = slashCommands.find(
        (candidate) => candidate.name === value.slice(1).trim()
      );

      if (command) {
        select(command);
      }

      return true;
    },
    [select]
  );

  return {
    close,
    handleKeyDown,
    index,
    open,
    query,
    select,
    submitTyped,
    trackInput,
  };
}
