export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "Legacy Heights · Room to become",
    template: "%s · Legacy Heights",
  },
  description:
    "A considered home for your next chapter. Explore accommodation and manage your residency with Legacy Heights.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
