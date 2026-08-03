import type { ProviderConfig } from "@ai-oauth-sdk/browser";
import { defineProvider, providers } from "@ai-oauth-sdk/browser";

/**
 * The built-in descriptors, with the endpoints the SDK *fetches* pointed at
 * this origin's proxy instead of the provider.
 *
 * This is the whole of the browser-side change, and it is deliberately the only
 * one. The SDK is not aware it is being proxied: `useAuth`, the receivers, PKCE
 * and storage all behave exactly as they do in a CLI, because a descriptor is
 * already the thing that says where a provider lives. Swapping the URLs is
 * enough, and it means the playground demonstrates the real client rather than
 * a special browser build of it.
 *
 * `authorizationUrl` is always left alone. That is a navigation, not a fetch —
 * the reader's browser goes to the provider and consents there, which is the
 * part that must not be proxied and could not be anyway.
 */
function proxy(provider: ProviderConfig): ProviderConfig {
  const at = (kind: string) => `/api/${kind}/${provider.id}`;

  return defineProvider({
    ...provider,
    ...(provider.apiBaseUrl ? { apiBaseUrl: at("upstream") } : {}),
    ...(provider.deviceAuthorizationUrl
      ? { deviceAuthorizationUrl: at("device") }
      : {}),
    ...(provider.revocationUrl ? { revocationUrl: at("revoke") } : {}),
    ...(provider.userInfoUrl ? { userInfoUrl: at("userinfo") } : {}),
    tokenUrl: at("token"),
  });
}

export const proxiedProviders: Record<string, ProviderConfig> =
  Object.fromEntries(
    Object.entries(providers).map(([id, provider]) => [
      id,
      proxy(provider as ProviderConfig),
    ])
  );
