import Link from "next/link";
import { getOverview } from "@/lib/admin/queries";
import { percent } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="kicker">{label}</span>
      <div className="n">{value}</div>
    </div>
  );
}

export default async function Overview() {
  const o = await getOverview();

  return (
    <>
      <h1>Overview</h1>

      <div className="stats">
        <Stat label="Active" value={o.active} />
        <Stat label="Confirm rate" value={percent(o.confirmRate)} />
        <Stat label="Reply rate / send" value={percent(o.replyRate)} />
        <Stat label="Stopped" value={o.stopped} />
        <Stat label="Bounce + spam" value={percent(o.bounceRate)} />
      </div>

      <h2>Totals</h2>
      <div className="stats">
        <Stat label="Subscribers" value={o.total} />
        <Stat label="Confirmed" value={o.confirmed} />
        <Stat label="Dailies sent" value={o.dailiesSent} />
        <Stat label="Replies" value={o.repliesReceived} />
        <Stat label="Hard bounces" value={o.hardBounces} />
        <Stat label="Complaints" value={o.complaints} />
      </div>

      <h2>Signups, last 14 days</h2>
      {o.signupsPerDay.length === 0 ? (
        <p className="muted">No signups yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Signups</th>
              </tr>
            </thead>
            <tbody>
              {o.signupsPerDay.map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td className="num">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Next</h2>
      <p className="muted">
        <Link href="/admin/sends">Sends</Link> lists the last 24 hours with
        failures first. <Link href="/admin/subscribers">Subscribers</Link> is
        where you preview and tune a specific person&rsquo;s next email.
      </p>
    </>
  );
}
