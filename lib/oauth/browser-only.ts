/**
 * Refuses to run outside a browser.
 *
 * This app's central claim is that a provider token stays in the tab it was
 * granted to — nothing is sent to or stored on a server of ours. On the client
 * that is enforced by the browser itself: one page, one reader, one
 * `sessionStorage`. On the server there is no such boundary. A module is
 * evaluated once per lambda instance and its module scope is shared by every
 * concurrent reader, so any store built there is a cross-user store by
 * construction, however it is keyed.
 *
 * The modules that call this all live in `"use client"` import graphs, which
 * makes it tempting to assume they cannot run on a server. They can: Next
 * evaluates and renders client components on the server during SSR, and a
 * Server Action or route handler can import them outright. What keeps them
 * client-only today is only that every call site happens to sit inside an
 * effect or an event handler — a placement no test enforces and no reviewer
 * would think to defend.
 *
 * The failure this replaces was silent, which is what made it worth a guard
 * rather than a comment. `sessionStorageAdapter()` from `@ai-oauth-sdk/browser`
 * falls back to `memoryStorage()` — a plain `Map` — when `sessionStorage` is
 * undefined, and that fallback is deliberate: nothing throws and nothing warns.
 * A `clientFor()` call moved into a render body would therefore work, look
 * correct, pass review, and pool every reader's tokens into one `Map`. Throwing
 * here turns that into an error at the moment of misuse, on the first render,
 * rather than into a leak nobody observes.
 *
 * `typeof window` rather than a check on `sessionStorage`: a browser that
 * denies storage (private mode, a locked-down profile) also lands on the
 * in-memory fallback, and there that is *correct* — the `Map` belongs to one
 * tab and dies with it. The server is the only case that is wrong.
 */
export function assertBrowser(subject: string): void {
  if (typeof window === "undefined") {
    throw new Error(
      `${subject} is browser-only and was reached from the server. Tokens in this app never leave the reader's tab, and anything server-side would be shared by every reader at once. Move the call into an effect or an event handler.`
    );
  }
}
