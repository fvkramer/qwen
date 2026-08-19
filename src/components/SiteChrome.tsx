import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="logo" href="/">
        Qwen
      </Link>
      <span className="kicker">Your personal trainer</span>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span className="logo">Qwen</span>
      <span className="small">
        Not medical advice. Reply &ldquo;stop&rdquo; anytime and the emails
        stop.
      </span>
    </footer>
  );
}
