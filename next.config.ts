import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents stays off: it rejects the explicit `runtime = "nodejs"`
  // the OAuth proxy route pins itself to, and that guarantee wins.
  devIndicators: false,
  experimental: {
    appNewScrollHandler: true,
    inlineCss: true,
    prefetchInlining: true,
    turbopackFileSystemCacheForDev: true,
  },
  // No `images` block on purpose: a `remotePatterns` allow-list keeps
  // `/_next/image` willing to fetch and cache from every host it names, and
  // nothing here renders a remote image. Add hosts back with a call site.
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  poweredByHeader: false,
  reactCompiler: true,
};

export default withBotId(nextConfig);
