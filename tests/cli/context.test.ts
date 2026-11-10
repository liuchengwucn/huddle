import { describe, expect, it } from "vitest";
import { assertVisibility } from "../../src/cli/context.js";
import { DEFAULT_REPO_CONFIG } from "../../src/config.js";
import { FakeTransport } from "../../src/transport/fake.js";

describe("assertVisibility", () => {
  it("refuses a public repo unless public: true", async () => {
    const t = new FakeTransport("a");
    t.private = false;
    await expect(assertVisibility(t, DEFAULT_REPO_CONFIG, "o/r")).rejects.toThrow(/o\/r is not private/);
    expect(await assertVisibility(t, { ...DEFAULT_REPO_CONFIG, public: true }, "o/r")).toBe(true);
  });

  it("returns false for a private repo", async () => {
    expect(await assertVisibility(new FakeTransport("a"), DEFAULT_REPO_CONFIG, "o/r")).toBe(false);
  });
});
