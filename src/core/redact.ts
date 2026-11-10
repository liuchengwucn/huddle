export interface RedactionHit {
  kind: string;
  index: number; // start offset of the match in the original text
}

interface Rule {
  kind: string;
  re: RegExp;      // must have g; add d and set group to replace only one capture group
  group?: number;
  skip?: (value: string) => boolean; // do not redact when this returns true
}

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,1024}/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,1024}/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,1024}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,1024}/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,1024}/g },
  { kind: "url-password", re: /\b[a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/[^\s:@/]{1,100}:([^\s@/]{1,200})@/dg, group: 1 },
  {
    kind: "env-secret",
    re: /\b[A-Z0-9_]{0,60}(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY)[A-Z0-9_]{0,60}[ \t]{0,5}[=:][ \t]{0,5}["']?([^\s"']{6,500})/dg,
    group: 1,
    skip: (v) => /^\d+$/.test(v), // all digits (e.g. TOKEN_TTL = 3600000) is not a secret
  },
];

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;
const BASE64 = /[A-Za-z0-9+/]{16,4096}={0,2}/g;

/** NFKC-normalize per code point and strip zero-width characters, recording the original-text span of each normalized character. */
function normalizeWithMap(s: string): { norm: string; start: number[]; end: number[] } {
  let norm = "";
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const n = ZERO_WIDTH.test(ch) ? "" : ch.normalize("NFKC");
    for (let k = 0; k < n.length; k++) {
      start.push(i);
      end.push(i + ch.length);
    }
    norm += n;
    i += ch.length;
  }
  return { norm, start, end };
}

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (const c of s) if (/[\x20-\x7E\n\r\t]/.test(c)) ok++;
  return ok / [...s].length;
}

interface Span { a: number; b: number; kind: string } // [a, b) in the normalized text

function ruleSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.group !== undefined) {
        const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices[rule.group];
        if (idx && !rule.skip?.(m[rule.group])) spans.push({ a: idx[0], b: idx[1], kind: rule.kind });
      } else {
        spans.push({ a: m.index!, b: m.index! + m[0].length, kind: rule.kind });
      }
    }
  }
  return spans;
}

export function redact(input: string): { text: string; hits: RedactionHit[] } {
  const { norm, start, end } = normalizeWithMap(input);
  const spans = ruleSpans(norm);
  for (const m of norm.matchAll(BASE64)) {
    const decoded = Buffer.from(m[0], "base64").toString("utf8");
    if (printableRatio(decoded) < 0.9) continue;
    const inner = ruleSpans(decoded);
    if (inner.length) spans.push({ a: m.index!, b: m.index! + m[0].length, kind: `${inner[0].kind}(base64)` });
  }
  spans.sort((x, y) => x.a - y.a || y.b - x.b);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.a < last.b) {
      last.b = Math.max(last.b, s.b);
      continue;
    }
    merged.push({ ...s });
  }
  let out = "";
  let pos = 0;
  const hits: RedactionHit[] = [];
  for (const s of merged) {
    if (s.b <= s.a) continue;
    const oa = start[s.a];
    const ob = end[s.b - 1];
    if (oa < pos) continue;
    out += input.slice(pos, oa) + `[REDACTED:${s.kind}]`;
    hits.push({ kind: s.kind, index: oa });
    pos = ob;
  }
  out += input.slice(pos);
  return { text: out, hits };
}
