import { cookies } from "next/headers";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { DataStreamProvider } from "@/components/chat/data-stream-provider";
import { ChatShell } from "@/components/chat/shell";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ActiveChatProvider } from "@/hooks/use-active-chat";
import { ProviderAuthProvider } from "@/hooks/use-provider-auth";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DataStreamProvider>
      <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
        <SidebarShell>{children}</SidebarShell>
      </Suspense>
    </DataStreamProvider>
  );
}

async function SidebarShell({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar />
      <SidebarInset>
        <Suspense fallback={<div className="flex h-dvh" />}>
          <ProviderAuthProvider>
            <ActiveChatProvider>
              <ChatShell />
            </ActiveChatProvider>
          </ProviderAuthProvider>
        </Suspense>
        {children}
      </SidebarInset>
      {/*
        A sibling of SidebarInset, whose `translate3d` would trap this in its
        stacking context. `zIndex` goes through `style` so it beats sonner's own
        stylesheet deterministically; `pointerEvents` opts back out of the
        `none` Radix puts on <body> while a dialog is open.
      */}
      <Toaster
        position="top-center"
        style={{ pointerEvents: "auto", zIndex: 51 }}
        theme="system"
        toastOptions={{
          className:
            "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
        }}
      />
    </SidebarProvider>
  );
}
