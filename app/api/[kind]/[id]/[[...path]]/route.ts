import { isBotRequest } from "@/lib/oauth/bot-gate";
import { forward } from "@/lib/oauth/proxy";
import { resolveTarget, withQuery } from "@/lib/oauth/targets";

/**
 * MUST stay on the Node runtime. Vercel's Edge runtime is a V8 isolate with the
 * same TLS fingerprint as a Cloudflare Worker, and several providers refuse
 * that fingerprint outright — Claude's token endpoint answers `429`, the Codex
 * API answers a Cloudflare block page. Node is accepted by all of them. This
 * one line is why the playground lives on Vercel rather than on Workers.
 *
 * It is also why `cacheComponents` is off in next.config.ts: enabling it makes
 * the build reject this export and tell you to remove it. Removing it would
 * still land on Node today, since that's the App Router default — but silently,
 * with nothing left in the tree recording that it has to. Don't delete this to
 * satisfy the compiler; disable cacheComponents instead, or this route goes to
 * Edge the next time the default changes.
 */
export const runtime = "nodejs";

type RouteParams = { id: string; kind: string; path?: string[] };

async function handler(
  request: Request,
  { params }: { params: Promise<RouteParams> }
) {
  // Bounded and fail-open — see `isBotRequest` for why a gate on a route that
  // already requires the caller's own provider token does not take the
  // deployment down with it when Vercel's bot-protection service is degraded.
  if (await isBotRequest()) {
    return Response.json({ error: "blocked" }, { status: 403 });
  }

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
