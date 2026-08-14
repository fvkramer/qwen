import { EMAIL_FOOTER } from "./footer";

export function confirmTemplate(confirmUrl: string) {
  return {
    subject: "Confirm your email",
    text: `You asked Qwen to start sending you one training email every morning. One click to confirm it's really you:

${confirmUrl}

If this wasn't you, ignore this and nothing happens.
${EMAIL_FOOTER}`,
  };
}
