export const HUDDLE_URL = "https://github.com/liuchengwucn/huddle";

/** Footer that marks a post as written through huddle, e.g. "— Sent by alice's agent via huddle". */
export const signature = (line: string, extra = ""): string => `\n\n---${extra}\n— ${line} via [huddle](${HUDDLE_URL})`;

// Only the separator directly above the footer, plus the one extra line huddle itself writes (sources or a decline's @mention).
// A wider match would swallow an entry's own `---` horizontal rules.
const TRAILING = /\n*---\n(?:(?:Sources: [^\n]*|@[^\n]* please confirm in person\.)\n)?— [^\n]* via \[huddle\]\([^)\n]*\)\s*$/;

/** Removes a trailing huddle footer, e.g. from a knowledge base entry body copied back for `publish --edit`, or for a search snippet. */
export const stripSignature = (text: string): string => text.replace(TRAILING, "");
