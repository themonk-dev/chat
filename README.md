<h1 align="center">Chat</h1>

<p align="center">
  Chat with seven AI providers using your own accounts. No signup, no API keys,
  nothing stored on a server of ours.
</p>

<p align="center">
  <a href="#how-it-works"><strong>How it works</strong></a> ·
  <a href="#providers"><strong>Providers</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a> ·
  <a href="#configuration"><strong>Configuration</strong></a>
</p>

## How it works

You sign in to a provider with OAuth. The token is written to `sessionStorage`
in your own tab and never leaves it: every model call is made from the browser
by the AI SDK, with your token on the request. Chat history lives in
`localStorage`.

There is no database, no session store and no server-side model key. The one
server-side piece is a closed proxy at `/api/[kind]/[id]/[[...path]]`, which
exists because provider APIs are not reachable directly from a page (CORS, and
a token endpoint that wants a published client secret). It forwards the
`Authorization` header without reading it, and can only reach the hosts the
[ai-oauth-sdk](https://ai-oauth.themonk.dev) descriptors already ship.

## Providers

OpenRouter, ChatGPT (Codex), Claude, Gemini (Code Assist), Grok, GitHub Copilot
and Qwen. Which sign-in flow each uses is dictated by the client that vendor
published, not by a setting (`lib/oauth/registry.ts`):

| Flow | Providers | Why |
| --- | --- | --- |
| Device code | ChatGPT, Grok, GitHub Copilot, Qwen | No redirect URI is involved, so it works on any origin. |
| Popup | OpenRouter | Its key endpoint accepts any callback URL. |
| Paste | Claude, Gemini | Their clients register only a loopback redirect (and, for Claude, Anthropic's own hosted code page). A deployed origin is not a registered redirect URI, so the code is copied by hand. On `localhost` both get the popup instead. |

## Running locally

```bash
pnpm install
pnpm dev
```

The app runs on [localhost:3000](http://localhost:3000) with no configuration.
Gemini gets a popup sign-in on loopback and falls back to paste elsewhere,
because its Desktop-app client only accepts a loopback redirect.

```bash
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
pnpm check      # lint + format
pnpm build      # production build
```

## Configuration

There is none. No environment variables, no database, no session store and no
server-side model key — deploying is `git push`.

Google's token endpoint wants a `client_secret` alongside the PKCE code, and
the proxy appends the published gemini-cli one that the SDK ships
(`lib/oauth/proxy.ts`). It is a public desktop-client secret, not a confidential
one; PKCE is what protects the flow.

## Credits

Built by [themonk.dev](https://themonk.dev) using
[ai-oauth-sdk](https://ai-oauth.themonk.dev). The chat interface started from
[Vercel's Next.js AI Chatbot template](https://vercel.com/templates/next.js/chatbot).
