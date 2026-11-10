export const HUDDLE_URL = "https://github.com/liuchengwucn/huddle";

/** Footer that marks a post as written through huddle, e.g. "— Sent by alice's agent via huddle". */
export const signature = (line: string, extra = ""): string => `\n\n---${extra}\n— ${line} via [huddle](${HUDDLE_URL})`;

const TRAILING = /\n*---\n(?:[^\n]*\n)*?— [^\n]* via \[huddle\]\([^)\n]*\)\s*$/;

/** Removes a trailing huddle footer, e.g. from a card body copied back for `publish --edit`, or for a search snippet. */
export const stripSignature = (text: string): string => text.replace(TRAILING, "");
