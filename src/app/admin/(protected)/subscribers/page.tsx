import Link from "next/link";
import type { Subscriber } from "@/db/schema";
import { formatDateTime, relative, subscriberPill } from "@/lib/admin/format";
import { listSubscribers } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

const STATUSES: Array<Subscriber["status"]> = [
  "pending_confirm",
  "active",
  "paused",
  "stopped",
  "bounced",
];

export default async function Subscribers({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw);
  const rows = await listSubscribers(status);

  return (
    <>
      <h1>Subscribers</h1>

      <div className="filters">
        <Link href="/admin/subscribers" aria-current={!status}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/subscribers?status=${s}`}
            aria-current={status === s}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="muted">No subscribers{status ? ` with status ${status}` : ""}.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th className="num">Day</th>
                <th>Timezone</th>
                <th>Send</th>
                <th>Last sent</th>
                <th>Last reply</th>
                <th className="num">Replies</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/admin/subscribers/${row.id}`}>{row.email}</Link>
                    {row.holdDate ? (
                      <>
                        {" "}
                        <span className="pill pill--muted">held {row.holdDate}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <span className={subscriberPill(row.status)}>{row.status}</span>
                  </td>
                  <td className="num">{row.dayNumber}</td>
                  <td>{row.timezone}</td>
                  <td>
                    {String(row.sendHourLocal).padStart(2, "0")}:
                    {String(row.sendMinuteLocal).padStart(2, "0")}
                  </td>
                  <td title={formatDateTime(row.lastSentAt)}>
                    {relative(row.lastSentAt)}
                  </td>
                  <td title={formatDateTime(row.lastReplyAt)}>
                    {relative(row.lastReplyAt)}
                  </td>
                  <td className="num">{row.replyCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
