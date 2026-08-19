/**
 * Appended to every outbound email by sendEmail — never by callers, so it
 * cannot be forgotten on a new send path (§8: footer on every email).
 *
 * The one-click URL is what mailbox providers POST for RFC 8058
 * List-Unsubscribe; the human link points at the confirmation page.
 */
export function emailFooter(unsubscribeUrl: string): string {
  return `
—
Qwen is not medical advice. Reply "stop" anytime and the emails stop.
Unsubscribe: ${unsubscribeUrl}`;
}
