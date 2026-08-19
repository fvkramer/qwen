import Link from "next/link";
import { logout } from "@/app/admin/actions";
import { requireAdmin } from "@/lib/admin/auth";

// Guards every page in this route group. /admin/login sits outside the group
// so it stays reachable when signed out.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();

  return (
    <>
      <nav className="admin-nav">
        <Link className="logo" href="/admin">
          Qwen
        </Link>
        <Link href="/admin">Overview</Link>
        <Link href="/admin/subscribers">Subscribers</Link>
        <Link href="/admin/sends">Sends</Link>
        <form action={logout}>
          <button className="btn" type="submit">
            Sign out
          </button>
        </form>
      </nav>
      <main className="admin-main">{children}</main>
    </>
  );
}
