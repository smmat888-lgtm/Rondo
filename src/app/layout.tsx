import type { Metadata } from "next";
import Nav from "./Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rondo",
  description: "Scheduling, time clock and tips for bars and restaurants",
  icons: { icon: "/rondo-glow-appicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a className="brand" href="/schedule">
            <img src="/rondo-glow-appicon.svg" alt="" />
            rondo
          </a>
          <Nav />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
