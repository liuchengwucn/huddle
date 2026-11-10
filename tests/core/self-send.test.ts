import { afterEach, describe, expect, it } from "vitest";
import { classifyReply } from "../../src/core/conversation.js";
import { pendingFor } from "../../src/core/pending.js";
import { resolveRecipient } from "../../src/core/recipient.js";
import { FakeTransport } from "../../src/transport/fake.js";

describe("HUDDLE_ALLOW_SELF_SEND", () => {
  afterEach(() => {
    delete process.env.HUDDLE_ALLOW_SELF_SEND;
  });

  it("rejects self by default and allows it with the switch", async () => {
    const t = new FakeTransport("me");
    t.writers.add("me");
    await expect(resolveRecipient(t, "me", "me")).rejects.toThrow(/yourself/);
    process.env.HUDDLE_ALLOW_SELF_SEND = "1";
    expect(await resolveRecipient(t, "me", "me")).toBe("me");
  });

  it("lets the same account send and reply in one thread", async () => {
    const t = new FakeTransport("me");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "me" });
    expect(pendingFor(await t.getThread(1), "me")).toBeNull();
    process.env.HUDDLE_ALLOW_SELF_SEND = "1";
    expect(pendingFor(await t.getThread(1), "me")?.last.id).toBe(th.id);

    await t.reply(th, "because", { type: "reply", re: th.id });
    expect(pendingFor(await t.getThread(1), "me")).toBeNull();
    expect(classifyReply(await t.getThread(1))?.status).toBe("reply");

    const f = await t.reply(th, "more?", { type: "message" });
    expect(pendingFor(await t.getThread(1), "me")?.last.id).toBe(f.id);
    expect(classifyReply(await t.getThread(1))?.status).toBe("pending");
  });
});
