import type { DeclineReason, ResponderType } from "../core/types.js";

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "body_md", "confidence", "sources", "decline_reason"],
  properties: {
    kind: { type: "string", enum: ["reply", "decline"] },
    body_md: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    sources: { type: "array", items: { type: "string" } },
    decline_reason: { type: ["string", "null"], enum: ["low_confidence", "refused", null] },
  },
} as const;

export interface AgentOutput {
  kind: ResponderType;
  body_md: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
  decline_reason: "low_confidence" | "refused" | null;
}

export interface Decision {
  type: ResponderType;
  reason?: DeclineReason;
  body: string;
  sources: string[];
}

export class OutputParseError extends Error {}

function coerce(o: unknown): AgentOutput | null {
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r.kind !== "reply" && r.kind !== "decline") return null;
  if (typeof r.body_md !== "string" || !r.body_md.trim()) return null;
  const confidence = r.confidence === "high" || r.confidence === "low" ? r.confidence : "medium";
  const sources = Array.isArray(r.sources) ? r.sources.filter((s): s is string => typeof s === "string") : [];
  const dr = r.decline_reason === "low_confidence" || r.decline_reason === "refused" ? r.decline_reason : null;
  return { kind: r.kind, body_md: r.body_md, confidence, sources, decline_reason: dr };
}

/** Tries in order: the whole text, a ```json code block, then the first { through the last }. */
export function parseAgentOutput(text: string): AgentOutput {
  const candidates = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1].trim());
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) candidates.push(text.slice(s, e + 1));
  for (const c of candidates) {
    try {
      const out = coerce(JSON.parse(c));
      if (out) return out;
    } catch {
      // try the next candidate
    }
  }
  throw new OutputParseError("The responder agent's output is not the expected JSON");
}

/** Output handling rules. */
export function decide(o: AgentOutput): Decision {
  if (o.kind === "decline") return { type: "decline", reason: o.decline_reason ?? "refused", body: o.body_md, sources: o.sources };
  if (o.confidence === "low") {
    return { type: "decline", reason: "low_confidence", body: o.body_md, sources: o.sources };
  }
  return { type: "reply", body: o.body_md, sources: o.sources };
}
