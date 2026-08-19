import { unsubscribeByToken } from "@/lib/email/unsubscribe";

// RFC 8058 one-click endpoint: mailbox providers POST here when the reader
// uses the unsubscribe affordance the List-Unsubscribe header advertises.
// No confirmation step and no auth beyond the token — that is the contract.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const ok = await unsubscribeByToken(token);
  // Never confirm or deny that a token exists.
  return new Response(ok ? "Unsubscribed" : "Unsubscribed", { status: 200 });
}
