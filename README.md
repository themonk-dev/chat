<a href="https://chat.themonk.dev">
  <img alt="Chat with every AI provider in one place" src="https://chat.themonk.dev/opengraph-image">
  <h1 align="center">Chat</h1>
</a>

<p align="center">
  Chat with seven AI providers using your own accounts. No signup, no API keys,
  nothing stored on a server of ours.
</p>

<p align="center">
  <a href="#how-it-works"><strong>How it works</strong></a> ·
  <a href="#providers"><strong>Providers</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a> ·
  <a href="#deploying"><strong>Deploying</strong></a> ·
  <a href="#architecture"><strong>Architecture</strong></a>
</p>

## How it works

Sign in to a provider with OAuth. The token is written to `sessionStorage` in
your own tab and never leaves it: every model call is made **from the browser**
by the AI SDK, with your token on the request. Chat history lives in
`localStorage`.

There is no database, no session store, no accounts and no server-side model
key — so there is nothing on our side to breach, and nothing to configure.

The one server-side piece is a closed proxy at
`app/api/[kind]/[id]/[[...path]]`, which exists because provider APIs are not
reachable directly from a page (CORS, and a token endpoint that wants a
published client secret). It forwards the `Authorization` header without
reading it, and can only reach the hosts the
[ai-oauth-sdk](https://ai-oauth.themonk.dev) descriptors already ship.

## Providers

OpenRouter, ChatGPT (Codex), Claude, Gemini (Code Assist), Grok, GitHub Copilot
and Qwen — each through the account you already pay for, spending your own
quota.

Which sign-in flow each uses is dictated by the client that vendor published,
not by a setting (`lib/oauth/registry.ts`):

| Flow | Providers | Why |
| --- | --- | --- |
| Device code | ChatGPT, Grok, GitHub Copilot, Qwen | No redirect URI is involved, so it works on any origin. |
| Popup | OpenRouter | Its key endpoint accepts any callback URL. |
| Paste | Claude, Gemini | Their clients register only a loopback redirect (and, for Claude, Anthropic's own hosted code page). A deployed origin is not a registered redirect URI, so the code is copied by hand. On `localhost` both get the popup instead. |

The device grant is the only one needing no redirect URI, and it is what puts
four of them on every origin. Both Anthropic and Google expose that endpoint
and both refuse their published clients — probed live; see the note in
`lib/oauth/registry.ts`. Paste is not a stopgap there.

## Running locally

```bash
pnpm install
pnpm dev
```

The app runs on [localhost:3000](http://localhost:3000) with no configuration.
On loopback, Claude and Gemini get the popup flow instead of paste.

```bash
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
pnpm check      # lint + format (ultracite/biome)
pnpm build      # production build
```

## Deploying

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fthemonk-dev%2Fchat)

No environment variables. The proxy route pins itself to the Node runtime —
a V8-isolate runtime has the TLS fingerprint of a Cloudflare Worker, which the
Codex API refuses outright.

Google's token endpoint wants a `client_secret` alongside the PKCE code, and
the proxy sends the published gemini-cli one that the SDK ships
(`lib/oauth/proxy.ts`). It is a public desktop-client secret, not a
confidential one; PKCE is what protects the flow.

`vercel.json` deploys `main` only — a preview per branch would be a second
live copy of the proxy on a URL anyone holding it could use.

## Architecture

```
app/api/[kind]/[id]/[[...path]]  closed proxy — forwards Authorization, never reads it
lib/oauth/targets.ts             the only hosts that proxy can reach
lib/oauth/registry.ts            which sign-in flow each provider gets, and why
lib/oauth/transport.ts           runs streamText in the browser, per provider
lib/oauth/adapters.ts            builds an AI SDK model pointed at the proxy
lib/chats/store.ts               chat history, localStorage only
hooks/use-provider-auth.tsx      owns the active provider and its tokens
hooks/use-active-chat.tsx        owns the thread, selection and send path
```

Tokens are `sessionStorage` (gone when the tab closes) and every module that
touches them asserts it is running in a browser — on a server, module scope is
shared by every concurrent reader, so any store built there would be a
cross-user store however it is keyed (`lib/oauth/browser-only.ts`).

## Credits

Built by [themonk.dev](https://themonk.dev) using
[ai-oauth-sdk](https://ai-oauth.themonk.dev). The chat interface started from
[Vercel's Next.js AI Chatbot template](https://vercel.com/templates/next.js/chatbot).
