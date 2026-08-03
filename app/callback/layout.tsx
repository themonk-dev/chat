import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Completing sign-in",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
