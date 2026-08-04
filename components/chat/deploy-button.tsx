import { Button } from "@/components/ui/button";

const REPOSITORY_URL = "https://github.com/themonk-dev/chat";
const DEPLOY_URL = `https://vercel.com/new/clone?repository-url=${encodeURIComponent(
  REPOSITORY_URL
)}`;

/**
 * The mark is inline SVG rather than `https://vercel.com/button`, which is an
 * image of the whole button: that would be a remote asset on every page load
 * and a second visual language in the header. No `env` params either — the app
 * takes no configuration, so the clone form has nothing to ask for.
 *
 * Hidden below `sm`, where the header has no room and nobody is deploying.
 */
export function DeployButton() {
  return (
    <Button
      asChild
      className="hidden h-7 gap-1.5 rounded-lg border-border/50 px-2 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:border-border/50 focus-visible:ring-0 active:translate-y-0 sm:inline-flex"
      size="sm"
      variant="outline"
    >
      <a
        data-testid="deploy-button"
        href={DEPLOY_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        <svg
          aria-hidden="true"
          className="size-3"
          fill="currentColor"
          viewBox="0 0 76 65"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
        </svg>
        Deploy
      </a>
    </Button>
  );
}
