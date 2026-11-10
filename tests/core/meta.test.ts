import { describe, expect, it } from "vitest";
import { decodeBody, encodeBody } from "../../src/core/meta.js";

describe("meta", () => {
  it("round-trips metadata and text", () => {
    const body = encodeBody({ type: "ask", to: "alice", files: ["src/a.ts"] }, "hello\nworld");
    expect(body.split("\n")[0]).toBe('<!-- huddle:v1 {"type":"ask","to":"alice","files":["src/a.ts"]} -->');
    expect(decodeBody(body)).toEqual({ meta: { type: "ask", to: "alice", files: ["src/a.ts"] }, text: "hello\nworld" });
  });

  it("escapes --> inside values", () => {
    const body = encodeBody({ type: "kb", files: ["a-->b"] }, "x");
    expect(body.split("\n")[0].indexOf("-->")).toBe(body.split("\n")[0].length - 3);
    expect(decodeBody(body).meta).toEqual({ type: "kb", files: ["a-->b"] });
  });

  it("handles CRLF", () => {
    expect(decodeBody('<!-- huddle:v1 {"type":"followup"} -->\r\nhi')).toEqual({ meta: { type: "followup" }, text: "hi" });
  });

  it("treats missing or broken metadata as human message", () => {
    for (const raw of [
      "just text",
      "<!-- huddle:v1 {broken -->\nx",
      '<!-- huddle:v1 {"type":"nope"} -->\nx',
      '<!-- huddle:v1 {"type":"ask"} -->\nx', // ask missing to
      '<!-- huddle:v1 {"type":"answer"} -->\nx', // answer missing re
      '<!-- huddle:v1 {"type":"ask","to":""} -->\nx',
      '<!-- huddle:v1 {"type":"answer","re":""} -->\nx',
      '<!-- huddle:v1 {"type":"decline","re":"1"} -->\nx', // decline missing reason
      '<!-- huddle:v1 {"type":"decline","re":"1","reason":"bogus"} -->\nx',
      '<!-- huddle:v1 {"type":"ask","to":"a","files":[1]} -->\nx',
      '<!-- huddle:v1 [1,2] -->\nx',
    ]) {
      expect(decodeBody(raw)).toEqual({ meta: null, text: raw });
    }
  });

  it("accepts metadata-only body", () => {
    expect(decodeBody('<!-- huddle:v1 {"type":"followup"} -->')).toEqual({ meta: { type: "followup" }, text: "" });
  });
});
