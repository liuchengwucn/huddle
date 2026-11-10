import { describe, expect, it } from "vitest";
import { classifyReply, unansweredAskerMessages } from "../../src/core/conversation.js";
import { pendingFor } from "../../src/core/pending.js";
import { FakeTransport } from "../../src/transport/fake.js";

async function scenario() {
  const t = new FakeTransport("bob");
  const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
  return { t, th };
}

describe("conversation", () => {
  it("classifies replies by re, not by time", async () => {
    const { t, th } = await scenario();
    expect(classifyReply(await t.getThread(1))!.status).toBe("pending");
    const f1 = await t.reply(th, "more", { type: "followup" });
    // alice replied to the opening message, not f1: f1 is still pending
    await t.as("alice").reply(th, "answer", { type: "answer", re: th.id });
    expect(classifyReply(await t.getThread(1))!.status).toBe("pending");
    await t.reply(th, "need info", { type: "clarify", re: f1.id });
    const c = classifyReply(await t.getThread(1))!;
    expect(c.status).toBe("clarify");
    expect(c.reply!.body).toBe("need info");
  });

  it("ignores messages from others and messages without metadata", async () => {
    const { t, th } = await scenario();
    await t.as("carol").reply(th, "x", { type: "followup" });
    t.as("bob").humanComment(th, "human note");
    const full = await t.getThread(1);
    expect(classifyReply(full)!.awaiting.id).toBe(th.id);
  });

  it("computes unanswered asker messages after last re", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "followup" });
    await t.as("alice").reply(th, "a", { type: "answer", re: f1.id });
    const f2 = await t.as("bob").reply(th, "f2", { type: "followup" });
    const f3 = await t.reply(th, "f3", { type: "followup" });
    expect(unansweredAskerMessages(await t.getThread(1), "alice").map((m) => m.id)).toEqual([f2.id, f3.id]);
  });

  it("keeps newer ask pending when responder replies out of order to an older ask", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "followup" });
    const f2 = await t.reply(th, "f2", { type: "followup" });
    await t.as("alice").reply(th, "a2", { type: "answer", re: f2.id });
    await t.reply(th, "a1", { type: "answer", re: f1.id }); // late reply to an older message
    const f3 = await t.as("bob").reply(th, "f3", { type: "followup" });
    const full = await t.getThread(1);
    expect(classifyReply(full)!.status).toBe("pending");
    expect(unansweredAskerMessages(full, "alice").map((m) => m.id)).toEqual([f3.id]);
    expect(pendingFor(full, "alice")).not.toBeNull();
  });

  it("falls back to time when every re target was deleted", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "followup" });
    await t.as("alice").reply(th, "a", { type: "answer", re: f1.id });
    const f2 = await t.as("bob").reply(th, "f2", { type: "followup" });
    await t.deleteMessage(f1.id);
    expect(unansweredAskerMessages(await t.getThread(1), "alice").map((m) => m.id)).toEqual([f2.id]);
  });

  it("matches logins case-insensitively", async () => {
    const t = new FakeTransport("Bob");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "ALICE" });
    await t.as("alice").reply(th, "a", { type: "answer", re: th.id });
    const f = await t.as("Bob").reply(th, "f", { type: "followup" });
    const full = await t.getThread(1);
    expect(unansweredAskerMessages(full, "Alice").map((m) => m.id)).toEqual([f.id]);
    expect(pendingFor(full, "aLiCe")).not.toBeNull();
  });

  it("returns null for non-huddle threads", async () => {
    const t = new FakeTransport("bob");
    await t.createThread("kb", "card", "body", { type: "kb" });
    expect(classifyReply(await t.getThread(1))).toBeNull();
  });
});
