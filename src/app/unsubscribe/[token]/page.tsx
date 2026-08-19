import { redirect } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { unsubscribeByToken } from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

// The human-facing link from the email footer. It asks before acting: link
// scanners and mail-security crawlers follow every URL in an email, and a GET
// that unsubscribes on sight would quietly drop real subscribers.
async function confirm(formData: FormData): Promise<void> {
  "use server";
  const token = String(formData.get("token"));
  await unsubscribeByToken(token);
  redirect(`/unsubscribe/${token}?done=1`);
}

export default async function Unsubscribe({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const done = (await searchParams).done === "1";

  return (
    <>
      <SiteHeader />
      <main className="confirmed-main">
        {done ? (
          <>
            <h1 className="display">That&rsquo;s done.</h1>
            <p className="lede">
              No more emails from Qwen. If you change your mind, you can sign up
              again on the homepage any time — take care of yourself.
            </p>
          </>
        ) : (
          <>
            <h1 className="display">Stop the emails?</h1>
            <p className="lede">
              One click and Qwen stops writing to you. Nothing else happens, and
              you can start again whenever you like.
            </p>
            <form action={confirm}>
              <input type="hidden" name="token" value={token} />
              <button className="btn btn--primary" type="submit">
                Yes, unsubscribe me
              </button>
            </form>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
