import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const SITE_NAME = "chat.themonk.dev";
const SITE_URL = "https://chat.themonk.dev";
const TITLE = "chat.themonk.dev — one chat, every AI subscription";
const DESCRIPTION =
  "Chat with ChatGPT, Claude, Gemini, Grok and more using the plans you already pay for. Switch provider mid-conversation. No API keys.";
const TWITTER_DESCRIPTION =
  "Use the AI plans you already pay for. Switch provider mid-conversation. No API keys.";
const OG_IMAGE_ALT = "Every AI subscription you pay for. One chat window.";

/**
 * `/og.png` is a rewrite onto `app/og/route.tsx` (see next.config.ts), so a
 * static `public/og.png` can take over later without touching these tags.
 */
const OG_IMAGE = {
  alt: OG_IMAGE_ALT,
  height: 630,
  url: "/og.png",
  width: 1200,
};

export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  openGraph: {
    description: DESCRIPTION,
    images: [OG_IMAGE],
    siteName: SITE_NAME,
    title: TITLE,
    type: "website",
    url: SITE_URL,
  },
  title: TITLE,
  twitter: {
    card: "summary_large_image",
    description: TWITTER_DESCRIPTION,
    images: [OG_IMAGE],
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
