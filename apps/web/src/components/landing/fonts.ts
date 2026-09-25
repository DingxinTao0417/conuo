import localFont from "next/font/local";

/**
 * Geist (SIL Open Font License 1.1, see fonts/OFL-Geist.txt) for Latin text and
 * numerals on the homepage; Chinese falls back to the system CJK fonts.
 * `preload: false` keeps signed-in workspace pages from preloading these files.
 */
export const landingSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  preload: false,
});

export const landingMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});
