import { describe, expect, it } from "vitest";
import { decodeBody, encodeBody } from "../../src/core/meta.js";

describe("meta", () => {
  it("round-trips metadata and text", () => {
    const body = encodeBody({ type: "message", to: "alice" }, "hello\nworld");
    expect(body.split("\n")[0]).toBe('<!-- huddle:v1 {"type":"message","to":"alice"} -->');
    expect(decodeBody(body)).toEqual({ meta: { type: "message", to: "alice" }, text: "hello\nworld" });
  });

  it("escapes --> inside values", () => {
    const body = encodeBody({ type: "message", to: "a-->b" }, "x");
    expect(body.split("\n")[0].indexOf("-->")).toBe(body.split("\n")[0].length - 3);
    expect(decodeBody(body).meta).toEqual({ type: "message", to: "a-->b" });
  });

  it("handles CRLF", () => {
    expect(decodeBody('<!-- huddle:v1 {"type":"message"} -->\r\nhi')).toEqual({ meta: { type: "message" }, text: "hi" });
  });

  it("accepts every type", () => {
    for (const json of ['{"type":"kb"}', '{"type":"reply","re":"1"}', '{"type":"decline","re":"1","reason":"timeout"}', '{"type":"message"}']) {
      expect(decodeBody(`<!-- huddle:v1 ${json} -->\nx`).meta).toEqual(JSON.parse(json));
    }
  });

  it("treats missing or broken metadata as human message", () => {
    for (const raw of [
      "just text",
      "<!-- huddle:v1 {broken -->\nx",
      '<!-- huddle:v1 {"type":"nope"} -->\nx',
      '<!-- huddle:v1 {"type":"ask","to":"a"} -->\nx', // removed type
      '<!-- huddle:v1 {"type":"reply"} -->\nx', // reply missing re
      '<!-- huddle:v1 {"type":"message","to":""} -->\nx',
      '<!-- huddle:v1 {"type":"message","to":5} -->\nx',
      '<!-- huddle:v1 {"type":"reply","re":""} -->\nx',
      '<!-- huddle:v1 {"type":"decline","re":"1"} -->\nx', // decline missing reason
      '<!-- huddle:v1 {"type":"decline","re":"1","reason":"bogus"} -->\nx',
      '<!-- huddle:v1 [1,2] -->\nx',
    ]) {
      expect(decodeBody(raw)).toEqual({ meta: null, text: raw });
    }
  });

  it("accepts metadata-only body", () => {
    expect(decodeBody('<!-- huddle:v1 {"type":"message"} -->')).toEqual({ meta: { type: "message" }, text: "" });
  });
});
