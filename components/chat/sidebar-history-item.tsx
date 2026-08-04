import Link from "next/link";
import { memo, useCallback } from "react";
import type { Chat } from "@/lib/chats/history";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { MoreHorizontalIcon, TrashIcon } from "./icons";

const PureChatItem = ({
  chat,
  isActive,
  onDelete,
  setOpenMobile,
}: {
  chat: Chat;
  isActive: boolean;
  onDelete: (chatId: string) => void;
  setOpenMobile: (open: boolean) => void;
}) => {
  const closeMobile = useCallback(() => {
    setOpenMobile(false);
  }, [setOpenMobile]);

  const handleDelete = useCallback(() => {
    onDelete(chat.id);
  }, [chat.id, onDelete]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        // Every row carries the border so only its colour changes when the
        // selection moves. Drawing it on the active row alone would add a pixel
        // per side and nudge the whole list.
        className="h-8 rounded-lg border border-transparent text-[13px] text-sidebar-foreground/50 transition-all duration-150 hover:bg-transparent hover:text-sidebar-foreground data-active:bg-transparent data-active:font-normal data-active:text-sidebar-foreground/50 data-[active=true]:border-dashed data-[active=true]:border-sidebar-foreground/50 data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground"
        isActive={isActive}
      >
        <Link href={`/chat/${chat.id}`} onClick={closeMobile}>
          <span className="truncate">{chat.title}</span>
        </Link>
      </SidebarMenuButton>

      <DropdownMenu modal={true}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className="mr-0.5 rounded-md text-sidebar-foreground/50 ring-0 transition-colors duration-150 focus-visible:ring-0 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            showOnHover={!isActive}
          >
            <MoreHorizontalIcon />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuItem onSelect={handleDelete} variant="destructive">
            <TrashIcon />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
};

export const ChatItem = memo(
  PureChatItem,
  (prevProps, nextProps) =>
    prevProps.isActive === nextProps.isActive &&
    prevProps.chat.id === nextProps.chat.id &&
    prevProps.chat.title === nextProps.chat.title
);
