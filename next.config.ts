import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

const basePath = process.env.IS_DEMO === "1" ? "/demo" : "";

const nextConfig: NextConfig = {
  ...(basePath
    ? {
        assetPrefix: "/demo-assets",
        basePath,
        redirects: async () => [
          {
            basePath: false,
            destination: basePath,
            permanent: false,
            source: "/",
          },
        ],
      }
    : {}),
  /*
   * cacheComponents is deliberately off. Turning it on rejects any explicit
   * `runtime` route segment config — not only `runtime = "edge"` — and
   * app/api/[kind]/[id]/[[...path]]/route.ts pins itself to `runtime = "nodejs"`
   * on purpose. That route wins: it's a build-checked guarantee that the
   * OAuth proxy never lands on a V8-isolate runtime, versus a client-navigation
   * optimization this two-route app doesn't need.
   */
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  experimental: {
    appNewScrollHandler: true,
    inlineCss: true,
    prefetchInlining: true,
    turbopackFileSystemCacheForDev: true,
  },
  /*
   * There is deliberately no `images` block. Nothing in this app renders a
   * remote image — `next/image` is not imported anywhere — but a
   * `remotePatterns` allow-list keeps `/_next/image` willing to fetch,
   * optimize and cache from every host it names. The inherited one named
   * `*.public.blob.vercel-storage.com`, which is a wildcard over every Vercel
   * Blob store on the internet rather than ours, so anyone could point the
   * deployment's bandwidth at their own bucket. Add hosts back only alongside
   * an actual `next/image` call site.
   */
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
