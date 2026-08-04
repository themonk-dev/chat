import type { ProviderConfig } from "@ai-oauth-sdk/browser";
import { defineProvider, providers } from "@ai-oauth-sdk/browser";

/**
 * Points every endpoint the SDK *fetches* at this origin's proxy. A descriptor
 * already says where a provider lives, so this is the whole browser-side
 * change. `authorizationUrl` stays: that is a navigation, not a fetch.
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
