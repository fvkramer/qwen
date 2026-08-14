// Strip quoted history and signatures from an email reply body, keeping only
// what the person actually typed. Heuristic equivalent of email-reply-parser.

const QUOTE_HEADER_PATTERNS: RegExp[] = [
  /^On .{5,200} wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:\s.+$/m,
  /^_{5,}\s*$/m,
  /^Le .{5,200} a écrit\s*:/m,
];

const SIGNATURE_PATTERNS: RegExp[] = [
  /^--\s*$/m,
  /^Sent from my (iPhone|iPad|Android|Galaxy|Samsung|mobile)/im,
  /^Get Outlook for (iOS|Android)/im,
];

export function stripQuotedReply(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  // Cut at the earliest quote header.
  let cutAt = text.length;
  for (const pattern of QUOTE_HEADER_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < cutAt) cutAt = match.index;
  }
  text = text.slice(0, cutAt);

  // Drop "> quoted" lines that survived.
  text = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

  // Cut at the earliest signature marker.
  cutAt = text.length;
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < cutAt) cutAt = match.index;
  }
  text = text.slice(0, cutAt);

  return text.trim();
}

/** True if the body is just the given command word, alone on the first line. */
export function isBareCommand(body: string, words: string[]): boolean {
  const firstLine = body.trim().split("\n")[0]?.trim().toLowerCase().replace(/[.!]+$/, "");
  return words.includes(firstLine ?? "");
}
