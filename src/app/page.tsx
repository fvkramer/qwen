import { SignupForm } from "@/components/SignupForm";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function Home({
  searchParams,
}: {
  searchParams: Search;
}) {
  const sp = await searchParams;
  const target = typeof sp.f === "string" ? sp.f : undefined;
  const statusFor = (id: "hero" | "poster") =>
    target === id ? (sp.ok ? ("ok" as const) : sp.err ? ("err" as const) : undefined) : undefined;

  return (
    <>
      <SiteHeader />

      <section className="hero">
        <div className="hero-left">
          <h1 className="display">
            A trainer that lives
            <br className="br-wide" /> in your inbox.
          </h1>
          <p className="lede">
            Qwen sends you one email every morning: what to do today, why it
            matters, and a question or two. You reply in plain words. There is
            no app to download and no dashboard to keep up with.
          </p>
          <SignupForm
            id="hero"
            status={statusFor("hero")}
            microcopy={`One email a day, 6:30am your time. Reply "stop" and it stops.`}
          />
        </div>

        <div className="hero-right">
          <span className="kicker">Tomorrow, 6:30am</span>
          <div className="email-sample">
            <div className="meta-row">
              <span className="k">From</span>
              <span className="v">Qwen &lt;coach@qwen.fit&gt;</span>
            </div>
            <div className="meta-row">
              <span className="k">Subject</span>
              <span className="v">Day 12 — short walk, then legs</span>
            </div>
            <div className="email-body">
              <p>Morning. You said Tuesdays are tight, so today is 25 minutes.</p>
              <p>
                Walk 10 minutes first. Then two rounds: 10 squats to a chair, 8
                slow step-ups, 30 seconds of holding still at the bottom. Stop a
                rep early if your knee talks back.
              </p>
              <p>
                Last week you slept badly after late workouts, which is why this
                one is in the morning.
              </p>
              <p>How did the knee feel on Sunday&rsquo;s walk? Just reply.</p>
            </div>
          </div>
          <p className="sample-caption">
            Your reply goes straight back into the plan.
          </p>
        </div>
      </section>

      <section className="how-band">
        <h2>How it works</h2>
      </section>

      <section className="cells">
        <div className="cell">
          <span className="num">01</span>
          <h3>Say where you&rsquo;re starting</h3>
          <p>
            Answer the first email in a sentence or two. No fitness vocabulary
            required, and zero is a fine place to begin.
          </p>
        </div>
        <div className="cell">
          <span className="num">02</span>
          <h3>Get one email each morning</h3>
          <p>
            A plan for the day, sized to the time you actually have, with the
            reasoning written out so you learn as you go.
          </p>
        </div>
        <div className="cell">
          <span className="num">03</span>
          <h3>Reply, and it adjusts</h3>
          <p>
            Slept badly, skipped two days, knees hurt: say so. Qwen keeps all of
            it and connects it to what comes next.
          </p>
        </div>
      </section>

      <section className="poster">
        <h2>Everything you tell it, it keeps. You never repeat yourself.</h2>
        <SignupForm
          id="poster"
          variant="poster"
          status={statusFor("poster")}
          microcopy="No app, no login. Just the inbox you already read."
        />
      </section>

      <SiteFooter />
    </>
  );
}
