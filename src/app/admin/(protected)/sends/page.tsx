import Link from "next/link";
import { resendMessage } from "@/app/admin/actions";
import { formatDateTime, messagePill, relative } from "@/lib/admin/format";
import { getRecentSends } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

export default async function Sends() {
  const { sends, failures } = await getRecentSends();

  return (
    <>
      <h1>Sends</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Last 24 hours. Failed and bounced sends sort to the top.
      </p>

      <h2>Failures</h2>
      {failures.length === 0 ? (
        <p className="muted">No generation or send failures logged.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Subscriber</th>
                <th>Stage</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((failure, i) => (
                <tr key={`${failure.at.toISOString()}-${i}`}>
                  <td title={formatDateTime(failure.at)}>
                    {relative(failure.at)}
                  </td>
                  <td>
                    {failure.subscriberId ? (
                      <Link href={`/admin/subscribers/${failure.subscriberId}`}>
                        {failure.email ?? failure.subscriberId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className="pill pill--alert">{failure.stage}</span>
                  </td>
                  <td>{failure.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Messages</h2>
      {sends.length === 0 ? (
        <p className="muted">Nothing sent in the last 24 hours.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Subscriber</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Subject</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sends.map(({ message, email, subscriberId }) => (
                <tr key={message.id}>
                  <td title={formatDateTime(message.createdAt)}>
                    {relative(message.createdAt)}
                  </td>
                  <td>
                    <Link href={`/admin/subscribers/${subscriberId}`}>
                      {email}
                    </Link>
                  </td>
                  <td>{message.kind}</td>
                  <td>
                    <span className={messagePill(message.status)}>
                      {message.status}
                    </span>
                  </td>
                  <td>{message.subject}</td>
                  <td>{message.error ?? ""}</td>
                  <td>
                    {message.status === "failed" ? (
                      <form action={resendMessage}>
                        <input
                          type="hidden"
                          name="messageId"
                          value={message.id}
                        />
                        <button className="btn" type="submit">
                          Retry
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
