import { registry } from "@/lib/oauth/registry";
import { providerLogos } from "./provider-logos";

/**
 * One provider's brand mark, wherever a provider has to be identified without
 * room for its name.
 *
 * Shared rather than copied because a reader has to recognise the same mark in
 * all the places it appears — the model picker's rows and trigger, and the
 * attribution line under a reply — and because both of those use it in the one
 * situation that makes it load-bearing: two connected providers can resell the
 * same model under the same display name (GitHub Copilot and OpenRouter both
 * carry "Claude Sonnet 4.5"), so the mark is the only thing distinguishing
 * "answered by Anthropic" from "answered through OpenRouter".
 *
 * `providerLogos`' SVGs are `aria-hidden` by design — they are normally read
 * beside a visible text label — but in both of those places the mark can be the
 * only provider signal present, so it gets its own accessible name here via a
 * wrapping `role="img"` rather than inheriting the hidden state from the SVG it
 * wraps.
 *
 * Everything is looked up defensively: a stored message can name a provider
 * this build no longer ships, and a footnote is never worth throwing a render
 * for.
 */
export function ProviderMark({
  className,
  providerId,
}: {
  className?: string;
  providerId: string;
}) {
  const Logo = providerLogos[providerId];

  if (!Logo) {
    return null;
  }

  return (
    <span
      aria-label={`${registry[providerId]?.label ?? providerId} logo`}
      className="inline-flex shrink-0 items-center"
      role="img"
    >
      <Logo className={className ?? "size-4"} />
    </span>
  );
}
