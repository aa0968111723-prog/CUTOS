import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CUTOS — Conversational Video Editor",
  description: "Agent-first, non-destructive video editing driven by natural language.",
};

/**
 * Mobile is the primary surface, so the viewport is declared explicitly.
 * `maximumScale` is left alone deliberately — pinch-zoom is an accessibility
 * affordance, not a layout bug.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <body>{children}</body>
    </html>
  );
}
