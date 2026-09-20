import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conuo",
  description: "陪你把知识学会。收集资料、阅读原文，保存自己的理解。",
  applicationName: "Conuo",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/conuo-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/conuo-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/conuo-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
  appleWebApp: {
    capable: true,
    title: "Conuo",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
