import Link from "next/link";
import { notFound } from "next/navigation";
import {
  previewNext,
  resendMessage,
  sendNow,
  sendPreview,
  setStatus,
  toggleHold,
  updateSchedule,
} from "@/app/admin/actions";
import {
  formatDateTime,
  formatLocal,
  messagePill,
  relative,
  subscriberPill,
} from "@/lib/admin/format";
import { getSubscriberDetail } from "@/lib/admin/queries";
import { previewModels } from "@/lib/ai/client";

export const dynamic = "force-dynamic";

export default async function SubscriberDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getSubscriberDetail(id);
  if (!detail) notFound();

  const { subscriber, profile, timeline, preview, safetyFlags } = detail;
  const models = previewModels();
  const lastDaily = timeline.find(
    (e) => e.type === "message" && e.message.kind === "daily",
  );

  return (
    <>
      <h1>{subscriber.email}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        <span className={subscriberPill(subscriber.status)}>
          {subscriber.status}
        </span>{" "}
        · day {subscriber.dayNumber} · {subscriber.timezone} ·{" "}
        {String(subscriber.sendHourLocal).padStart(2, "0")}:
        {String(subscriber.sendMinuteLocal).padStart(2, "0")} local · joined{" "}
        {formatDateTime(subscriber.createdAt)} ·{" "}
        <Link href="/admin/subscribers">back to list</Link>
      </p>

      {safetyFlags.length > 0 ? (
        <div className="card" style={{ borderColor: "var(--color-accent)" }}>
          <h3>Safety flags</h3>
          {safetyFlags.map((flag) => (
            <p key={flag.at.toISOString()} className="muted">
              <span className="pill pill--alert">{flag.flag}</span>{" "}
              {formatDateTime(flag.at)} — answered with the fixed response; the
              model never saw it.
            </p>
          ))}
        </div>
      ) : null}

      <h2>Actions</h2>
      <div className="card card--plain">
        <div className="actions">
          <form action={previewNext} className="actions">
            <input type="hidden" name="subscriberId" value={subscriber.id} />
            <div className="field">
              <label className="kicker" htmlFor="preview-model">
                Model
              </label>
              <input
                id="preview-model"
                name="model"
                list="openrouter-models"
                defaultValue={models[0] ?? ""}
                placeholder="vendor/model-slug"
                size={28}
              />
              <datalist id="openrouter-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <button className="btn" type="submit">
              {preview ? "Regenerate preview" : "Preview next email"}
            </button>
          </form>
          <form action={sendNow}>
            <input type="hidden" name="subscriberId" value={subscriber.id} />
            <button className="btn" type="submit">
              Generate &amp; send now
            </button>
          </form>
          <form action={toggleHold}>
            <input type="hidden" name="subscriberId" value={subscriber.id} />
            <button className="btn" type="submit">
              {subscriber.holdDate
                ? `Clear hold (${subscriber.holdDate})`
                : "Hold next send"}
            </button>
          </form>
          <form action={setStatus}>
            <input type="hidden" name="subscriberId" value={subscriber.id} />
            <input
              type="hidden"
              name="status"
              value={subscriber.status === "paused" ? "active" : "paused"}
            />
            <button className="btn" type="submit">
              {subscriber.status === "paused" ? "Resume" : "Pause"}
            </button>
          </form>
          {lastDaily?.type === "message" ? (
            <form action={resendMessage}>
              <input
                type="hidden"
                name="messageId"
                value={lastDaily.message.id}
              />
              <button className="btn" type="submit">
                Resend last daily
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="card card--plain">
        <h3>Schedule</h3>
        <form action={updateSchedule} className="actions">
          <input type="hidden" name="subscriberId" value={subscriber.id} />
          <div className="field">
            <label className="kicker" htmlFor="timezone">
              IANA timezone
            </label>
            <input
              id="timezone"
              name="timezone"
              defaultValue={subscriber.timezone}
              required
            />
          </div>
          <div className="field">
            <label className="kicker" htmlFor="sendHourLocal">
              Hour
            </label>
            <input
              id="sendHourLocal"
              name="sendHourLocal"
              type="number"
              min={0}
              max={23}
              defaultValue={subscriber.sendHourLocal}
              required
            />
          </div>
          <div className="field">
            <label className="kicker" htmlFor="sendMinuteLocal">
              Minute
            </label>
            <input
              id="sendMinuteLocal"
              name="sendMinuteLocal"
              type="number"
              min={0}
              max={59}
              defaultValue={subscriber.sendMinuteLocal}
              required
            />
          </div>
          <button className="btn" type="submit">
            Save schedule
          </button>
        </form>
        <p className="muted" style={{ marginTop: 10 }}>
          The hourly cron sends when the subscriber&rsquo;s local hour matches.
        </p>
      </div>

      <h2>Next email</h2>
      {preview ? (
        <div className="card">
          <p className="muted" style={{ marginBottom: 10 }}>
            Preview of day {preview.dayNumber ?? subscriber.dayNumber + 1},
            generated {relative(preview.at)}
            {preview.model ? ` by ${preview.model}` : ""}. Not sent.
          </p>
          <div className="entry" style={{ paddingBottom: 0 }}>
            <div className="subject">{preview.subject}</div>
            <div className="body">{preview.body}</div>
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <form action={sendPreview}>
              <input type="hidden" name="subscriberId" value={subscriber.id} />
              <button className="btn btn--primary" type="submit">
                Send this
              </button>
            </form>
            <form action={previewNext}>
              <input type="hidden" name="subscriberId" value={subscriber.id} />
              <input type="hidden" name="model" value={preview.model ?? ""} />
              <button className="btn" type="submit">
                Regenerate
              </button>
            </form>
          </div>
        </div>
      ) : (
        <p className="muted">
          No preview yet. Generate one to read what Qwen would write for this
          person today — nothing is sent until you press Send.
        </p>
      )}

      <h2>Profile</h2>
      {profile ? (
        <>
          <div className="card">
            <h3>Summary</h3>
            <div className="body" style={{ whiteSpace: "pre-wrap" }}>
              {profile.summary || "(empty)"}
            </div>
          </div>
          <div className="card">
            <h3>Facts</h3>
            <pre>{JSON.stringify(profile.facts, null, 2)}</pre>
          </div>
          <div className="card">
            <h3>Current plan</h3>
            <pre>{JSON.stringify(profile.currentPlan ?? null, null, 2)}</pre>
          </div>
        </>
      ) : (
        <p className="muted">
          No profile yet — it is written the first time they reply.
        </p>
      )}

      <h2>Timeline</h2>
      {timeline.length === 0 ? (
        <p className="muted">Nothing sent or received yet.</p>
      ) : (
        timeline.map((entry) =>
          entry.type === "message" ? (
            <div className="entry" key={`m-${entry.message.id}`}>
              <div className="meta">
                <span className="pill">{entry.message.kind}</span>
                <span className={messagePill(entry.message.status)}>
                  {entry.message.status}
                </span>
                {entry.message.dayNumber ? (
                  <span>day {entry.message.dayNumber}</span>
                ) : null}
                <span>{formatLocal(entry.at, subscriber.timezone)} local</span>
                {entry.message.model ? <span>{entry.message.model}</span> : null}
              </div>
              <div className="subject">{entry.message.subject}</div>
              <div className="body">{entry.message.bodyText}</div>
              {entry.message.error ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  Error: {entry.message.error}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="entry entry--reply" key={`r-${entry.reply.id}`}>
              <div className="meta">
                <span className="pill pill--alert">reply</span>
                <span>{formatLocal(entry.at, subscriber.timezone)} local</span>
                <span>
                  {entry.reply.processedAt ? "folded in" : "not yet folded in"}
                </span>
              </div>
              <div className="body">{entry.reply.bodyText}</div>
            </div>
          ),
        )
      )}
    </>
  );
}
