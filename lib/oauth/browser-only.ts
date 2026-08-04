/**
 * Module scope on the server is shared by every concurrent reader, so any token
 * store built there is a cross-user store however it is keyed — and the SDK's
 * in-memory fallback makes that failure silent. `typeof window` rather than a
 * `sessionStorage` check: a browser denying storage lands on the same fallback,
 * and there it is correct.
 */
export function assertBrowser(subject: string): void {
  if (typeof window === "undefined") {
    throw new Error(
      `${subject} is browser-only and was reached from the server. Tokens in this app never leave the reader's tab, and anything server-side would be shared by every reader at once. Move the call into an effect or an event handler.`
    );
  }
}
