import { describe, expect, it } from "vitest";
import { parseNoreplyEmail, resolveRecipient } from "../../src/core/recipient.js";
import { FakeTransport } from "../../src/transport/fake.js";

describe("recipient", () => {
  it("parses noreply emails", () => {
    expect(parseNoreplyEmail("123456+alice-w@users.noreply.github.com")).toBe("alice-w");
    expect(parseNoreplyEmail("alice@users.noreply.github.com")).toBe("alice");
    expect(parseNoreplyEmail("alice@corp.com")).toBeNull();
  });

  it("resolves login, noreply and plain emails, then checks write access", async () => {
    const t = new FakeTransport("bob");
    t.writers.add("alice");
    t.emails.set("alice@corp.com", "alice");
    expect(await resolveRecipient(t, "alice", "bob")).toBe("alice");
    expect(await resolveRecipient(t, "@alice", "bob")).toBe("alice");
    expect(await resolveRecipient(t, "1+alice@users.noreply.github.com", "bob")).toBe("alice");
    expect(await resolveRecipient(t, "Alice@Corp.com", "bob")).toBe("alice");
  });

  it("rejects unresolvable, self and non-writers", async () => {
    const t = new FakeTransport("bob");
    t.writers.add("bob");
    await expect(resolveRecipient(t, "ghost@corp.com", "bob")).rejects.toThrow(/Cannot resolve email/);
    await expect(resolveRecipient(t, "ghost@corp.com", "bob", () => ["Ghost Z", "G"])).rejects.toThrow(/Author names for this email in git log: Ghost Z, G/);
    await expect(resolveRecipient(t, "ghost@corp.com", "bob", () => [])).rejects.toThrow(/not linked to a GitHub account/);
    await expect(resolveRecipient(t, "BOB", "bob")).rejects.toThrow(/yourself/);
    await expect(resolveRecipient(t, "carol", "bob")).rejects.toThrow(/write access/);
  });
});
