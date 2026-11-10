import { HuddleError } from "../errors.js";

interface DiscussionUrl {
  owner: string;
  repo: string;
  number: number;
}

/** Parses https://github.com/o/r/discussions/n[#discussioncomment-id] (http, www. and a missing scheme are tolerated). */
function parseDiscussionUrl(ref: string): DiscussionUrl | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/discussions\/(\d+)\/?(?:#discussioncomment-\w+)?$/i.exec(ref.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** Accepts 123, #123, or https://github.com/o/r/discussions/123 (optionally with a #discussioncomment-<id> fragment); a URL must point at the transport repo. */
export function parseThreadRef(ref: string, transport?: string): number {
  const s = ref.trim();
  const plain = /^#?(\d+)$/.exec(s);
  if (plain) return Number(plain[1]);
  if (/\/discussions\//i.test(s)) {
    const u = parseDiscussionUrl(s);
    if (!u) throw new HuddleError(`${ref} is not a recognised GitHub discussion URL (expected https://github.com/<owner>/<repo>/discussions/<n>).`);
    if (transport && `${u.owner}/${u.repo}`.toLowerCase() !== transport.toLowerCase()) {
      throw new HuddleError(`${ref} belongs to ${u.owner}/${u.repo}, but huddle threads live in ${transport}.`);
    }
    return u.number;
  }
  throw new HuddleError(`Unrecognized thread reference: ${ref} (use 123, #123, or a Discussion URL)`);
}
