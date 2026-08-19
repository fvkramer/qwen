import { redirect } from "next/navigation";
import { login } from "@/app/admin/actions";
import { isAuthenticated } from "@/lib/admin/auth";

export default async function AdminLogin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await isAuthenticated()) redirect("/admin");
  const failed = (await searchParams).err === "1";

  return (
    <>
      <nav className="admin-nav">
        <span className="logo">Qwen</span>
        <span className="kicker">Admin</span>
      </nav>
      <main className="login-main">
        <h1>Sign in</h1>
        <form action={login}>
          <div className="field">
            <label className="kicker" htmlFor="password">
              Admin password
            </label>
            <input
              id="password"
              type="password"
              name="password"
              required
              autoFocus
            />
          </div>
          {failed ? (
            <p className="micro error" style={{ marginBottom: 12 }}>
              That password is wrong.
            </p>
          ) : null}
          <button className="btn btn--primary" type="submit">
            Sign in
          </button>
        </form>
      </main>
    </>
  );
}
