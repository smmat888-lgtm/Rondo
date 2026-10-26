"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  ["/schedule", "Schedule"],
  ["/clock", "Time clock"],
  ["/me", "My hours"],
  ["/tips", "Tips"],
] as const;

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className={path.startsWith(href) ? "on" : ""}>
          {label}
        </a>
      ))}
    </nav>
  );
}
