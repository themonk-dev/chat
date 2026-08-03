import { forward } from "@/lib/oauth/proxy";
import { resolveTarget, withQuery } from "@/lib/oauth/targets";

/**
 * MUST stay on the Node runtime. Vercel's Edge runtime is a V8 isolate with the
 * same TLS fingerprint as a Cloudflare Worker, and several providers refuse
 * that fingerprint outright — Claude's token endpoint answers `429`, the Codex
 * API answers a Cloudflare block page. Node is accepted by all of them. This
 * one line is why the playground lives on Vercel rather than on Workers.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { id: string; kind: string; path?: string[] };

async function handler(
  request: Request,
  { params }: { params: Promise<RouteParams> }
) {
  const { id, kind, path = [] } = await params;
  const target = resolveTarget(kind, id, path);

  if (!target) {
    return Response.json({ error: "unknown_route" }, { status: 404 });
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
