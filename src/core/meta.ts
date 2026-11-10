import type { DeclineReason, Meta, MsgType } from "./types.js";

const PREFIX = "<!-- huddle:v1 ";
const SUFFIX = " -->";
const TYPES: ReadonlySet<string> = new Set<MsgType>(["ask", "followup", "answer", "clarify", "decline", "kb"]);
const REASONS: ReadonlySet<string> = new Set<DeclineReason>([
  "low_confidence", "refused", "timeout", "error", "rate_limited",
]);

export function encodeBody(meta: Meta, text: string): string {
  // Escape < and > so a "-->" inside a value cannot end the HTML comment early
  const json = JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${PREFIX}${json}${SUFFIX}\n${text}`;
}

export function decodeBody(raw: string): { meta: Meta | null; text: string } {
  const m = /^([^\r\n]*)(?:\r?\n([\s\S]*))?$/.exec(raw);
  const first = (m?.[1] ?? "").trim();
  if (!first.startsWith(PREFIX) || !first.endsWith(SUFFIX)) return { meta: null, text: raw };
  let obj: unknown;
  try {
    obj = JSON.parse(first.slice(PREFIX.length, first.length - SUFFIX.length));
  } catch {
    return { meta: null, text: raw };
  }
  if (!isMeta(obj)) return { meta: null, text: raw };
  return { meta: obj, text: m?.[2] ?? "" };
}

const isStr = (v: unknown): v is string => typeof v === "string";

function isMeta(o: unknown): o is Meta {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  if (!isStr(r.type) || !TYPES.has(r.type)) return false;
  for (const k of ["to", "re", "commit", "source", "supersedes"]) {
    if (r[k] !== undefined && !isStr(r[k])) return false;
  }
  if (r.reason !== undefined && !(isStr(r.reason) && REASONS.has(r.reason))) return false;
  if (r.files !== undefined && !(Array.isArray(r.files) && r.files.every(isStr))) return false;
  if (r.type === "ask" && !(isStr(r.to) && r.to)) return false;
  if ((r.type === "answer" || r.type === "clarify" || r.type === "decline") && !(isStr(r.re) && r.re)) return false;
  if (r.type === "decline" && r.reason === undefined) return false;
  return true;
}
