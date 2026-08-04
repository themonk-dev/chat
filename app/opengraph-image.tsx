import { ImageResponse } from "next/og";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";

/**
 * There is no sibling app/twitter-image.tsx. Next's file convention already
 * wires this route into both `openGraph.images` and `twitter.images` on its
 * own — confirmed by inspecting the rendered <head>, which carries a
 * twitter:image (plus twitter:image:width/height/alt/type) pointing at
 * /opengraph-image with no twitter-image file and no `images` set in
 * app/layout.tsx's metadata. A second file would just render this same
 * artwork a second time for no visual difference.
 */
export const alt =
  "Chat with every AI provider in one place — OpenRouter, ChatGPT, Claude, Gemini, Grok, GitHub Copilot, and Qwen";
export const contentType = "image/png";
export const size = { height: 630, width: 1200 };

/**
 * Copied verbatim from app/layout.tsx, which keeps them as unexported
 * consts. Duplicated here rather than exporting them from layout.tsx just to
 * share two strings with an image route — if the copy in layout.tsx changes,
 * update this too.
 */
const TITLE = "Chat with every AI provider in one place";
const SHORT_DESCRIPTION =
  "One place to chat with seven AI providers using your own accounts. No signup, no API keys, nothing stored on our servers.";

/**
 * satori (the renderer behind ImageResponse) wraps this headline on its own
 * using greedy word-wrap sized to the container width, which broke it as
 * "Chat with every AI provider in one" / "place" — a single word stranded
 * on its own line. There's no CSS `text-wrap: balance` support to lean on
 * here, so the line break is chosen explicitly instead, derived from TITLE
 * itself (not retyped) so the two never drift out of sync.
 */
const TITLE_WORDS = TITLE.split(" ");
const TITLE_LINE_1 = TITLE_WORDS.slice(0, 5).join(" ");
const TITLE_LINE_2 = TITLE_WORDS.slice(5).join(" ");

// Matches the site's monochrome dark-mode tokens in app/globals.css
// (--background, --foreground, --muted-foreground, --border), converted
// from oklch to hex since satori doesn't resolve oklch().
const BACKGROUND = "#151515";
const FOREGROUND = "#ebebeb";
const MUTED = "#808080";
const BORDER = "#262626";

// Real, seven providers, in the same order the app lists them — set as type
// rather than logos: the marks in components/chat/provider-logos.tsx carry
// brand colors and (Gemini) filters/masks that satori can't render
// faithfully, and this card is monochrome and typographic by design.
const providerNames = PROVIDER_ORDER.map((id) => registry[id].label).join(
  "     ·     "
);

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        backgroundColor: BACKGROUND,
        color: FOREGROUND,
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        justifyContent: "space-between",
        padding: "80px",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 60, lineHeight: 1.15 }}>
            {TITLE_LINE_1}
          </div>
          <div style={{ display: "flex", fontSize: 60, lineHeight: 1.15 }}>
            {TITLE_LINE_2}
          </div>
        </div>
        <div
          style={{
            color: MUTED,
            fontSize: 30,
            lineHeight: 1.5,
            marginTop: 28,
            maxWidth: 980,
          }}
        >
          {SHORT_DESCRIPTION}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        <div style={{ fontSize: 26, letterSpacing: "0.01em" }}>
          {providerNames}
        </div>
        <div
          style={{
            borderTop: `1px solid ${BORDER}`,
            color: MUTED,
            fontSize: 24,
            letterSpacing: "0.02em",
            marginTop: 32,
            paddingTop: 28,
          }}
        >
          chat.themonk.dev
        </div>
      </div>
    </div>,
    { ...size }
  );
}
