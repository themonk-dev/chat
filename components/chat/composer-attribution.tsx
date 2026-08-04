import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

const LINK_CLASS =
  "inline-flex items-center gap-0.5 underline decoration-muted-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-foreground/50";

function CreditLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className={LINK_CLASS}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

/**
 * Sits inside the same sticky footer as the composer, so it can never scroll
 * over the conversation, and wraps rather than forcing height on mobile.
 */
export function ComposerAttribution() {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2 text-center text-[11px] text-muted-foreground/60">
      <span className="inline-flex items-center gap-1">
        built by
        <CreditLink href="https://themonk.dev">themonk.dev</CreditLink>
        using
        <CreditLink href="https://ai-oauth.themonk.dev">
          ai-oauth-sdk
        </CreditLink>
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        Chat interface based on
        <CreditLink href="https://vercel.com/templates/next.js/chatbot">
          Vercel's Next.js AI Chatbot template
        </CreditLink>
      </span>
    </p>
  );
}
