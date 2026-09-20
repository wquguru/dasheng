import "./globals.css";

export const metadata = {
  title: "大声读 — ReadAloud",
  description: "朗读经典文稿，R2T2 实时转写，JEV 逐词判分。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
