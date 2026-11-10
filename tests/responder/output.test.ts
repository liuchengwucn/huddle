import { describe, expect, it } from "vitest";
import { decide, parseAgentOutput } from "../../src/responder/output.js";

const base = { kind: "reply", body_md: "hi", confidence: "high", sources: ["a.ts:1"], decline_reason: null };

describe("output", () => {
  it("parses plain, fenced and embedded JSON", () => {
    expect(parseAgentOutput(JSON.stringify(base)).body_md).toBe("hi");
    expect(parseAgentOutput("```json\n" + JSON.stringify(base) + "\n```").kind).toBe("reply");
    expect(parseAgentOutput("Here you go: " + JSON.stringify(base) + " thanks").sources).toEqual(["a.ts:1"]);
  });

  it("rejects invalid output", () => {
    expect(() => parseAgentOutput("no json here")).toThrow();
    expect(() => parseAgentOutput(JSON.stringify({ ...base, kind: "maybe" }))).toThrow();
    expect(() => parseAgentOutput(JSON.stringify({ ...base, kind: "answer" }))).toThrow();
    expect(() => parseAgentOutput(JSON.stringify({ ...base, body_md: "" }))).toThrow();
  });

  it("applies decision rules", () => {
    expect(decide(parseAgentOutput(JSON.stringify(base)))).toMatchObject({ type: "reply" });
    expect(decide(parseAgentOutput(JSON.stringify({ ...base, confidence: "medium" })))).toMatchObject({ type: "reply" });
    expect(decide(parseAgentOutput(JSON.stringify({ ...base, confidence: "low" })))).toEqual({ type: "decline", reason: "low_confidence", body: "hi", sources: ["a.ts:1"] });
    expect(decide(parseAgentOutput(JSON.stringify({ ...base, kind: "decline" })))).toMatchObject({ type: "decline", reason: "refused" });
    expect(decide(parseAgentOutput(JSON.stringify({ ...base, kind: "decline", decline_reason: "low_confidence" })))).toMatchObject({ reason: "low_confidence" });
  });
});
