import { subscribe } from "@/app/actions/subscribe";

type Props = {
  id: "hero" | "poster";
  variant?: "light" | "poster";
  status?: "ok" | "err";
  microcopy: string;
};

export function SignupForm({ id, variant = "light", status, microcopy }: Props) {
  return (
    <form
      id={id}
      action={subscribe}
      className={`signup${variant === "poster" ? " signup--poster" : ""}`}
    >
      <input type="hidden" name="form" value={id} />
      {/*
        Deliberately stamped per render: this is a server component on a
        dynamic route, so the value is "when this visitor was served the page",
        which is exactly what the min-time-on-page bot check in subscribe()
        measures against. It would be wrong — and the check useless — if this
        page were ever prerendered.
      */}
      {/* eslint-disable-next-line react-hooks/purity */}
      <input type="hidden" name="t" value={Date.now()} />
      {/* Honeypot: humans never see this field; bots that fill it are dropped. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className="kicker" htmlFor={`${id}-email`}>
        Your email
      </label>
      <div className="signup-row">
        <input
          id={`${id}-email`}
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          autoComplete="email"
        />
        <button type="submit">Start tomorrow morning</button>
      </div>
      {status === "ok" ? (
        <p className="micro success">
          You&rsquo;re in. Your first email arrives tomorrow at 6:30am.
        </p>
      ) : status === "err" ? (
        <p className="micro error">
          That email doesn&rsquo;t look right. Try again?
        </p>
      ) : (
        <p className="micro">{microcopy}</p>
      )}
    </form>
  );
}
