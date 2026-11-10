import { afterEach, describe, expect, it } from "vitest";
import { classifyReply } from "../../src/core/conversation.js";
import { pendingFor } from "../../src/core/pending.js";
import { resolveRecipient } from "../../src/core/recipient.js";
import { FakeTransport } from "../../src/transport/fake.js";

describe("HUDDLE_ALLOW_SELF_ASK", () => {
  afterEach(() => {
    delete process.env.HUDDLE_ALLOW_SELF_ASK;
  });

  it("rejects self by default and allows it with the switch", async () => {
    const t = new FakeTransport("me");
    t.writers.add("me");
    await expect(resolveRecipient(t, "me", "me")).rejects.toThrow(/yourself/);
    process.env.HUDDLE_ALLOW_SELF_ASK = "1";
    expect(await resolveRecipient(t, "me", "me")).toBe("me");
  });

  it("lets the same account ask and answer one thread", async () => {
    const t = new FakeTransport("me");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "me" });
    expect(pendingFor(await t.getThread(1), "me")).toBeNull();
    process.env.HUDDLE_ALLOW_SELF_ASK = "1";
    expect(pendingFor(await t.getThread(1), "me")?.last.id).toBe(th.id);

    await t.reply(th, "because", { type: "answer", re: th.id });
    expect(pendingFor(await t.getThread(1), "me")).toBeNull();
    expect(classifyReply(await t.getThread(1))?.status).toBe("answer");

    const f = await t.reply(th, "more?", { type: "followup" });
    expect(pendingFor(await t.getThread(1), "me")?.last.id).toBe(f.id);
    expect(classifyReply(await t.getThread(1))?.status).toBe("pending");
  });
});
