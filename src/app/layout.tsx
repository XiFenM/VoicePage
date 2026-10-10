import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReadAloud · 边听边读",
  description: "把 AI 回复转成口述稿并生成语音，一边听一边读",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
