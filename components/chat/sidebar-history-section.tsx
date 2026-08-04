import type { ChatGroup } from "@/lib/chats/history";
import { ChatItem } from "./sidebar-history-item";

export function SidebarHistorySection({
  activeChatId,
  group,
  onDelete,
  setOpenMobile,
}: {
  activeChatId: string | null;
  group: ChatGroup;
  onDelete: (chatId: string) => void;
  setOpenMobile: (open: boolean) => void;
}) {
  return (
    <div>
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70">
        {group.label}
      </div>

      {group.chats.map((chat) => (
        <ChatItem
          chat={chat}
          isActive={chat.id === activeChatId}
          key={chat.id}
          onDelete={onDelete}
          setOpenMobile={setOpenMobile}
        />
      ))}
    </div>
  );
}
