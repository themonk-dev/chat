import { ImageResponse } from "next/og";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";

/** No sibling twitter-image.tsx: Next wires this route into both on its own. */
export const alt =
  "Chat with every AI provider in one place — OpenRouter, ChatGPT, Claude, Gemini, Grok, GitHub Copilot, and Qwen";
export const contentType = "image/png";
export const size = { height: 630, width: 1200 };

/** Copied from app/layout.tsx; update both together. */
const TITLE = "Chat with every AI provider in one place";
const SHORT_DESCRIPTION =
  "One place to chat with seven AI providers using your own accounts. No signup, no API keys, nothing stored on our servers.";

/**
 * satori has no `text-wrap: balance` and its greedy wrap strands "place" on a
 * line of its own, so the break is chosen here — derived from TITLE, not retyped.
 */
const TITLE_WORDS = TITLE.split(" ");
const TITLE_LINE_1 = TITLE_WORDS.slice(0, 5).join(" ");
const TITLE_LINE_2 = TITLE_WORDS.slice(5).join(" ");

// The site's dark-mode tokens, in hex because satori cannot resolve oklch().
const BACKGROUND = "#151515";
const FOREGROUND = "#ebebeb";
const MUTED = "#808080";
const BORDER = "#262626";

// Set as type rather than logos: the marks carry brand colors and (Gemini)
// masks that satori cannot render faithfully.
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
