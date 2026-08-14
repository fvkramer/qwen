import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "800"],
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  title: "Qwen — a trainer that lives in your inbox",
  description:
    "Qwen sends you one email every morning: what to do today, why it matters, and a question or two. You reply in plain words. No app, no dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
