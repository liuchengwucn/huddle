import { describe, expect, it } from "vitest";
import { signature, stripSignature } from "../../src/core/signature.js";

describe("signature", () => {
  it("round-trips through stripSignature", () => {
    expect(stripSignature("body" + signature("Sent by bob's agent"))).toBe("body");
    expect(stripSignature("answer" + signature("Replied automatically by alice's agent (claude)", "\nSources: a.ts:1"))).toBe("answer");
  });

  it("leaves bodies without a huddle footer alone", () => {
    expect(stripSignature("a\n\n---\nnot ours")).toBe("a\n\n---\nnot ours");
    expect(stripSignature("plain")).toBe("plain");
  });

  it("does not duplicate the footer when an edited card body includes the old one", () => {
    const old = "v1" + signature("Published by alice");
    expect(stripSignature(old + "\n") + signature("Updated by alice")).toBe("v1" + signature("Updated by alice"));
  });
});
