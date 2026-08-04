import { registry } from "@/lib/oauth/registry";
import { providerLogos } from "./provider-logos";

/**
 * Two providers can resell the same model under the same display name, so the
 * mark is the only thing distinguishing them in the picker and the attribution
 * line. It carries its own accessible name because in both places it can be the
 * only provider signal present.
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
