import { forward, uncacheable } from "@/lib/oauth/proxy";
import { isForeignOrigin } from "@/lib/oauth/same-origin";
import { resolveTarget, withQuery } from "@/lib/oauth/targets";

/**
 * MUST stay on Node. A V8-isolate runtime has the TLS fingerprint of a
 * Cloudflare Worker, which the Codex API refuses outright. Don't delete this to
 * satisfy `cacheComponents`; turn that off instead (see next.config.ts).
 */
export const runtime = "nodejs";

type RouteParams = { id: string; kind: string; path?: string[] };

async function handler(
  request: Request,
  { params }: { params: Promise<RouteParams> }
) {
  if (isForeignOrigin(request)) {
    return uncacheable(Response.json({ error: "blocked" }, { status: 403 }));
  }

  const { id, kind, path = [] } = await params;
  const target = resolveTarget(kind, id, path);

  if (!target) {
    return uncacheable(
      Response.json({ error: "unknown_route" }, { status: 404 })
    );
  }

  return forward(request, withQuery(target, new URL(request.url)));
}

export {
  handler as DELETE,
  handler as GET,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
