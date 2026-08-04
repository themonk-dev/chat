import { isToday, isYesterday, subMonths, subWeeks } from "date-fns";

export type Chat = {
  id: string;
  title: string;
  createdAt: string | Date;
};

export type ChatGroup = { chats: Chat[]; label: string };

const LABELS = {
  lastMonth: "Last 30 days",
  lastWeek: "Last 7 days",
  older: "Older",
  today: "Today",
  yesterday: "Yesterday",
} as const;

type GroupKey = keyof typeof LABELS;

/** Newest bucket first; the order here is the order the sidebar renders. */
const ORDER: GroupKey[] = [
  "today",
  "yesterday",
  "lastWeek",
  "lastMonth",
  "older",
];

function bucketFor(date: Date, oneWeekAgo: Date, oneMonthAgo: Date): GroupKey {
  if (isToday(date)) {
    return "today";
  }

  if (isYesterday(date)) {
    return "yesterday";
  }

  if (date > oneWeekAgo) {
    return "lastWeek";
  }

  if (date > oneMonthAgo) {
    return "lastMonth";
  }

  return "older";
}

/** Only non-empty groups come back, so the sidebar renders what it is given. */
export function groupChatsByDate(chats: Chat[]): ChatGroup[] {
  const now = new Date();
  const oneWeekAgo = subWeeks(now, 1);
  const oneMonthAgo = subMonths(now, 1);
  const buckets = new Map<GroupKey, Chat[]>();

  for (const chat of chats) {
    const key = bucketFor(new Date(chat.createdAt), oneWeekAgo, oneMonthAgo);
    const existing = buckets.get(key);

    if (existing) {
      existing.push(chat);
    } else {
      buckets.set(key, [chat]);
    }
  }

  return ORDER.filter((key) => buckets.get(key)?.length).map((key) => ({
    chats: buckets.get(key) ?? [],
    label: LABELS[key],
  }));
}
