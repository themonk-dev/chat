import { checkBotId } from "botid/server";

/**
 * How long BotID gets to answer before this request stops waiting for it.
 *
 * `checkBotId()` performs a blocking `fetch` to `api.vercel.com/bot-protection`
 * with no timeout of its own, on a route that then has to make a second,
 * streamed round trip to the provider. Two seconds is generous for a verdict
 * that normally lands in tens of milliseconds, and it caps what a degraded
 * bot-protection service can add to a chat turn.
 *
 * What it bounds is the *waiting*, not the request. `checkBotId()` takes no
 * abort signal, so a call this race abandons still holds an open socket to
 * `api.vercel.com` until it finishes on its own. Under a degraded service
 * that means latency stays bounded while concurrent connections do not —
 * which is the right trade for a route whose alternative is refusing
 * traffic, but it is a real cost and not a free timeout.
 */
const BOT_CHECK_TIMEOUT_MS = 2000;

/**
 * Whether BotID classified this request as a bot — **fail-open** on anything
 * that is not a clear "yes".
 *
 * This is the deliberate choice, and it is worth stating why, because the
 * opposite is also defensible: a gate that cannot reach its verdict service
 * arguably should refuse traffic.
 *
 * It does not here, for three reasons specific to this route:
 *
 * 1. **BotID is not the security boundary.** Nothing behind this route is
 *    reachable by getting past the gate. `resolveTarget` bounds the hosts to
 *    the ones the SDK ships, and every endpoint behind it bounds its own
 *    authorisation:
 *
 *    - `/api/upstream/*`, `/api/userinfo/*` and `/api/revoke/*` carry the
 *      caller's own provider credential — an OAuth token they signed in for,
 *      spending their own quota against their own account. Without one the
 *      upstream answers 401.
 *    - `/api/token/*` and `/api/device/*` deliberately carry *no* credential;
 *      they are how one is obtained. What bounds them is the exchange itself:
 *      a token request without a valid PKCE verifier, or a poll without a
 *      device code the provider issued, gets nothing back. An attacker who
 *      gets past BotID here reaches an endpoint that will not mint them
 *      anything.
 *
 *    So BotID is abuse *dampening* — it keeps casual scripted traffic off the
 *    deployment's bandwidth — not the thing that keeps anything safe. Trading
 *    availability for it is a bad exchange.
 *
 * 2. **Failing closed here breaks sign-in, not just sending.** The same
 *    handler serves `/api/token/*`. A `checkBotId()` that throws — which it
 *    does when `VERCEL_OIDC_TOKEN` is unset or the Vercel request context is
 *    missing, i.e. on any `next start` outside Vercel — would 500 the OAuth
 *    code exchange itself. The playground would not merely be unable to send
 *    a message; it would be unable to connect a provider at all, with a stack
 *    trace rather than a readable error.
 *
 * 3. **The failure is invisible to the user and unfixable by them.** A 403
 *    from a degraded verdict service is indistinguishable, from the browser,
 *    from a broken app. There is no retry, no captcha, no appeal.
 *
 * So: a positive `isBot` verdict is honoured (that is a real classification,
 * from a service that answered). A thrown error, a timeout, or a missing
 * verdict is treated as "not a bot" and the request proceeds. If the trade
 * ever needs reversing — say this deployment starts paying for scraped
 * traffic — this is the one function to change.
 */
export async function isBotRequest(): Promise<boolean> {
  // Cleared in `finally` so a verdict that lands quickly — the normal case —
  // does not leave a two-second timer holding the function alive behind it.
  let cancelTimeout = (): void => undefined;

  try {
    const verdict = await Promise.race([
      checkBotId(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, BOT_CHECK_TIMEOUT_MS);

        cancelTimeout = () => clearTimeout(timer);
      }),
    ]);

    return verdict?.isBot === true;
  } catch {
    /*
     * Swallowed rather than logged: the two thrown cases are configuration
     * facts about the deployment, identical on every request, so logging them
     * would emit one line per proxied call forever. Nothing about the request
     * — headers, token, body — is touched on this path either way.
     */
    return false;
  } finally {
    cancelTimeout();
  }
}
