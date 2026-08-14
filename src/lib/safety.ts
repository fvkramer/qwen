// Deterministic keyword screen for inbound replies (§8). These route to a
// fixed, human-written response — the model never freelances on them.

const EMERGENCY_PATTERNS: RegExp[] = [
  /chest pain|chest tight|pain in my chest/i,
  /faint(ed|ing)?|passed out|blacked? out/i,
  /coughing (up )?blood|blood in (my )?(stool|urine|vomit)|bleeding/i,
  /can'?t breathe|trouble breathing|short(ness)? of breath/i,
  /numbness .*(arm|face)|slurred speech/i,
];

const CRISIS_PATTERNS: RegExp[] = [
  /suicid|kill (myself|me)|end (my|it) (life|all)|want to die|no reason to live/i,
  /self[- ]?harm|hurt(ing)? myself|cutting myself/i,
];

export type SafetyFlag = "emergency" | "crisis" | null;

export function screenReply(text: string): SafetyFlag {
  if (CRISIS_PATTERNS.some((p) => p.test(text))) return "crisis";
  if (EMERGENCY_PATTERNS.some((p) => p.test(text))) return "emergency";
  return null;
}

// Fixed, human-written responses. Counted as kind 'system' and exempt from
// the one-email-a-day rule because they are urgent.
export const EMERGENCY_RESPONSE = {
  subject: "Please get this checked now",
  text: `What you just described isn't something to train through, and it isn't something I can help with — it needs a medical professional, today.

If it's happening right now, call your local emergency number (911 in the US). If it has passed, please still get seen before your next session.

The training emails will be here when you're cleared and ready. Nothing about your plan matters more than this.`,
};

export const CRISIS_RESPONSE = {
  subject: "Please read this",
  text: `Thank you for telling me. What you wrote matters more than anything about training, and it deserves real support from a real person.

If you are in the US, you can call or text 988 (the Suicide & Crisis Lifeline) any time, day or night. If you're elsewhere, findahelpline.com lists free, confidential lines for your country. If you are in immediate danger, call your local emergency number.

I'm pausing the training emails for now so they're not noise. Reply "resume" whenever you want them back — I'll be here.`,
};
