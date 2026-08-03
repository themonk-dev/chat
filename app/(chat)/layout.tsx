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
       * Rendered as a sibling of SidebarInset, not inside it: SidebarInset
       * sets `transform: translate3d(...)` (for GPU compositing), which
       * creates a new stacking context and would trap this toaster's
       * z-index below it, regardless of how high that z-index is. Sitting
       * outside that subtree keeps the toaster in the root stacking
       * context, alongside Dialog/AlertDialog, whose overlay and content
       * both portal to <body> at z-50.
       *
       * The z-index below is set via sonner's `style` prop rather than
       * `className`/global CSS: inline style deterministically overrides
       * sonner's own injected stylesheet, whereas a `className` z-index
       * utility would tie on selector specificity with sonner's rule and
       * the winner would depend on <style> tag insertion order -- a fight
       * with the library, not a configuration of it. 51 is one layer above
       * Dialog/AlertDialog's z-50, not an arbitrary high ceiling.
       *
       * `pointerEvents: "auto"` is required alongside it: Radix sets
       * `document.body.style.pointerEvents = "none"` while a Dialog or
       * AlertDialog is open (to make background content inert) and only
       * opts its own overlay/content back in. `pointer-events` inherits,
       * so once the toaster sits outside SidebarInset it inherits that
       * `none` from <body> like everything else and would render on top
       * while silently swallowing clicks -- this opts it back in, the same
       * way Dialog's own content does.
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
