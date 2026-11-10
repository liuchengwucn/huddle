import { describe, expect, it } from "vitest";
import { assertRefRepo, parseThreadRef } from "../../src/transport/refs.js";

describe("parseThreadRef", () => {
  it("accepts numbers and URLs of the transport repo", () => {
    expect(parseThreadRef("#5", "o/r")).toBe(5);
    expect(parseThreadRef("https://github.com/O/R/discussions/7#discussioncomment-1", "o/r")).toBe(7);
  });

  it("accepts http, www and scheme-less URLs of the transport repo", () => {
    expect(parseThreadRef("http://github.com/o/r/discussions/3", "o/r")).toBe(3);
    expect(parseThreadRef("https://www.github.com/O/R/discussions/4", "o/r")).toBe(4);
    expect(parseThreadRef("github.com/o/r/discussions/5#discussioncomment-9", "o/r")).toBe(5);
  });

  it("rejects non-matching or malformed discussion URLs", () => {
    expect(() => parseThreadRef("http://www.github.com/x/y/discussions/7", "o/r")).toThrow(/belongs to x\/y/);
    expect(() => parseThreadRef("github.com/x/y/discussions/7", "o/r")).toThrow(/belongs to x\/y/);
    expect(() => parseThreadRef("https://evil.com/o/r/discussions/7", "o/r")).toThrow(/not a recognised GitHub discussion URL/);
    expect(() => parseThreadRef("https://github.com.evil.com/o/r/discussions/7", "o/r")).toThrow(/not a recognised/);
    expect(() => parseThreadRef("https://github.com/o/r/discussions/7/evil", "o/r")).toThrow(/not a recognised/);
    expect(() => assertRefRepo("ftp://github.com/o/r/discussions/7", "o/r")).toThrow(/not a recognised/);
    expect(() => assertRefRepo("DC_kwDOabc", "o/r")).not.toThrow();
  });

  it("rejects URLs from another repo", () => {
    expect(() => parseThreadRef("https://github.com/x/y/discussions/7", "o/r")).toThrow(/belongs to x\/y, but huddle threads live in o\/r/);
  });
});
