"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { useChats } from "@/hooks/use-chats";
import { type Chat, groupChatsByDate } from "@/lib/chats/history";
import { SidebarHistorySection } from "./sidebar-history-section";

const GROUP_LABEL_CLASS =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70";

function EmptyHistory() {
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className={GROUP_LABEL_CLASS}>
        History
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <div className="flex w-full flex-row items-center justify-center gap-2 px-2 text-[13px] text-sidebar-foreground/60">
          Your conversations will appear here once you start chatting!
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function SidebarHistory() {
  const { setOpenMobile } = useSidebar();
  const pathname = usePathname();
  const router = useRouter();
  const { chats: storedChats, remove } = useChats();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const activeChatId = pathname?.startsWith("/chat/")
    ? pathname.split("/")[2]
    : null;

  const groups = useMemo(() => {
    const chats: Chat[] = storedChats.map((chat) => ({
      createdAt: new Date(chat.updatedAt),
      id: chat.id,
      title: chat.title,
    }));

    return groupChatsByDate(chats);
  }, [storedChats]);

  const handleDelete = useCallback(() => {
    setShowDeleteDialog(false);

    if (!deleteId) {
      return;
    }

    if (pathname === `/chat/${deleteId}`) {
      router.replace("/");
    }

    remove(deleteId);
    toast.success("Chat deleted");
  }, [deleteId, pathname, remove, router]);

  const handleShowDeleteDialog = useCallback((chatId: string) => {
    setDeleteId(chatId);
    setShowDeleteDialog(true);
  }, []);

  if (groups.length === 0) {
    return <EmptyHistory />;
  }

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className={GROUP_LABEL_CLASS}>
          History
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <SidebarHistorySection
                  activeChatId={activeChatId}
                  group={group}
                  key={group.label}
                  onDelete={handleShowDeleteDialog}
                  setOpenMobile={setOpenMobile}
                />
              ))}
            </div>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <AlertDialog onOpenChange={setShowDeleteDialog} open={showDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete your
              chat from this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
