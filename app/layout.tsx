import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const TITLE = "Chat with every AI provider in one place";
const DESCRIPTION =
  "Sign in with your own OpenRouter, ChatGPT, Claude, Gemini, Grok, GitHub Copilot, or Qwen account and start chatting right away. No signup, no API keys to paste — your OAuth token stays in this browser tab and chat history stays in local storage. Nothing is sent to or stored on our servers.";
const SHORT_DESCRIPTION =
  "One place to chat with seven AI providers using your own accounts. No signup, no API keys, nothing stored on our servers.";
const SITE_URL = "https://chat.themonk.dev";

/**
 * Neither block below sets `images`. app/opengraph-image.tsx uses Next's
 * file convention, which auto-populates both `openGraph.images` and
 * `twitter.images` from that one route — verified by inspecting the
 * rendered <head>, which carries a matching og:image and twitter:image
 * (same URL, plus width/height/alt/type) with no images field set here.
 * Setting `images` explicitly here would either duplicate that route's
 * `alt`/`size` exports (another string pair to keep in sync, on top of
 * TITLE/SHORT_DESCRIPTION below) or drop those fields from the tags
 * entirely — Next only fills them in for images it discovers itself.
 */
export const metadata: Metadata = {
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  openGraph: {
    description: SHORT_DESCRIPTION,
    title: TITLE,
    type: "website",
    url: SITE_URL,
  },
  title: TITLE,
  twitter: {
    card: "summary",
    description: SHORT_DESCRIPTION,
    title: TITLE,
  },
};

export const viewport = {
  maximumScale: 1,
};

const geist = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

const LIGHT_THEME_COLOR = "hsl(0 0% 100%)";
const DARK_THEME_COLOR = "hsl(240deg 10% 3.92%)";
const THEME_COLOR_SCRIPT = `\
(function() {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  function updateThemeColor() {
    var isDark = html.classList.contains('dark');
    meta.setAttribute('content', isDark ? '${DARK_THEME_COLOR}' : '${LIGHT_THEME_COLOR}');
  }
  var observer = new MutationObserver(updateThemeColor);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  updateThemeColor();
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${geist.variable} ${geistMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: "Required"
          dangerouslySetInnerHTML={{
            __html: THEME_COLOR_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
