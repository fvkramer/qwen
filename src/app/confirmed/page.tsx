import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default async function Confirmed({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const invalid = sp.state === "invalid";

  return (
    <>
      <SiteHeader />
      <main className="confirmed-main">
        {invalid ? (
          <>
            <h1 className="display">That link has expired.</h1>
            <p className="lede">
              It may have been used already, or replaced by a newer one. Sign up
              again on the homepage and a fresh confirmation will be in your
              inbox in a minute.
            </p>
          </>
        ) : (
          <>
            <h1 className="display">You&rsquo;re in.</h1>
            <p className="lede">
              A hello from Qwen is on its way to your inbox — reply to it with a
              few plain words about where you&rsquo;re starting. Your first plan
              arrives tomorrow morning at 6:30, your time.
            </p>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
