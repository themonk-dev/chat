import { ImageResponse } from "next/og";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";

/**
 * The social card, served at `/og.png` through a rewrite so a static
 * `public/og.png` can replace it later without touching any metadata.
 *
 * A route rather than `app/opengraph-image.tsx`: that file convention injects
 * its own `og:image`, which would duplicate the one `app/layout.tsx` sets.
 */
export const runtime = "nodejs";

const SIZE = { height: 630, width: 1200 };

const EYEBROW = "BRING YOUR OWN LOGINS · SWITCH PROVIDER MID-THREAD";
const HEADLINE_LINE_1 = "Every AI subscription you pay";
const HEADLINE_LINE_2 = "for. One chat window.";
const PILL = "signed in with your own plan — no API key";
const DOMAIN = "chat.themonk.dev";

const BACKGROUND = "#ffffff";
const FOREGROUND = "#0a0a0a";
const MUTED = "#8a8a8a";
const BODY = "#4a4a4a";
const BORDER = "#e6e6e6";
const SURFACE = "#fafafa";
const ACCENT = "#22c55e";

/**
 * `nowrap` rather than trusting satori's greedy wrap, which has no
 * `text-wrap: balance` and stranded "pay" on a line of its own at any size
 * wide enough to read. The break is chosen here; the size is what makes the
 * longer line fit inside 1040px of content width.
 */
const HEADLINE_SIZE = 58;

// Set as type rather than logos: the marks carry brand colors and (Gemini)
// masks that satori cannot render faithfully.
const providerNames = PROVIDER_ORDER.map((id) => registry[id].label).join(
  "  ·  "
);

export function GET() {
  return new ImageResponse(
    <div
      style={{
        backgroundColor: BACKGROUND,
        color: FOREGROUND,
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        justifyContent: "space-between",
        padding: "64px 80px",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: "0.01em",
        }}
      >
        {DOMAIN}
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            color: MUTED,
            display: "flex",
            fontSize: 21,
            letterSpacing: "0.14em",
          }}
        >
          {EYEBROW}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: HEADLINE_SIZE,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.14,
            marginTop: 22,
          }}
        >
          <div style={{ display: "flex", whiteSpace: "nowrap" }}>
            {HEADLINE_LINE_1}
          </div>
          <div style={{ display: "flex", whiteSpace: "nowrap" }}>
            {HEADLINE_LINE_2}
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            // Hugs its text rather than stretching to the column's width.
            alignSelf: "flex-start",
            backgroundColor: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: 999,
            color: BODY,
            display: "flex",
            fontSize: 22,
            gap: 12,
            marginTop: 32,
            padding: "16px 28px",
          }}
        >
          <div
            style={{
              backgroundColor: ACCENT,
              borderRadius: 999,
              display: "flex",
              height: 10,
              width: 10,
            }}
          />
          {PILL}
        </div>
      </div>

      <div
        style={{
          borderTop: `1px solid ${BORDER}`,
          color: MUTED,
          display: "flex",
          fontSize: 21,
          paddingTop: 26,
        }}
      >
        {providerNames}
      </div>
    </div>,
    SIZE
  );
}
