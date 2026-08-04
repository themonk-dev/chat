import { checkBotId } from "botid/server";

/**
 * `checkBotId()` has no timeout of its own and takes no abort signal, so this
 * bounds the *waiting*, not the request: an abandoned call still holds its
 * socket. Latency stays bounded, concurrent connections do not.
 */
const BOT_CHECK_TIMEOUT_MS = 2000;

/**
 * **Fail-open** on anything that is not a clear "yes". This gate is abuse
 * dampening, not the security boundary: every endpoint behind it either
 * requires the caller's own credential or mints nothing without a valid PKCE
 * verifier. Failing closed would 500 the OAuth exchange itself wherever
 * `checkBotId()` throws — any `next start` outside Vercel — so the app could
 * not connect a provider at all. Reverse the trade here if it ever needs it.
 */
export async function isBotRequest(): Promise<boolean> {
  // Cleared in `finally` so a quick verdict does not leave a two-second timer
  // holding the function alive behind it.
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
    // Swallowed rather than logged: the thrown cases are deployment
    // configuration, identical on every request.
    return false;
  } finally {
    cancelTimeout();
  }
}
