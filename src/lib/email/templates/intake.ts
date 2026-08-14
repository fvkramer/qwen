import { EMAIL_FOOTER } from "./footer";

export function intakeTemplate() {
  return {
    subject: "Quick hello from Qwen",
    text: `Hi — you're in. Your first plan arrives tomorrow morning.

Before then, reply to this email with a few plain sentences. No fitness vocabulary needed, and "I haven't exercised in years" is a completely fine starting point. Useful things to mention:

What you're hoping changes for you. How a normal day looks and how much time you honestly have. Anything that hurts or has hurt. What you have around — a mat, a pair of shoes, stairs, nothing.

Whatever you tell me, I keep. You'll never have to repeat yourself.
${EMAIL_FOOTER}`,
  };
}
