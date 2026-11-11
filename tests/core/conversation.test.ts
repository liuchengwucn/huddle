import { describe, expect, it } from "vitest";
import { classifyReply, messageMeta, unansweredSenderMessages } from "../../src/core/conversation.js";
import { pendingFor } from "../../src/core/pending.js";
import { FakeTransport } from "../../src/transport/fake.js";

async function scenario() {
  const t = new FakeTransport("bob");
  const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
  return { t, th };
}

describe("conversation", () => {
  it("classifies replies by re, not by time", async () => {
    const { t, th } = await scenario();
    expect(classifyReply(await t.getThread(1))!.status).toBe("pending");
    const f1 = await t.reply(th, "more", { type: "message" });
    // alice replied to the opening message, not f1: f1 is still pending
    await t.as("alice").reply(th, "reply", { type: "reply", re: th.id });
    expect(classifyReply(await t.getThread(1))!.status).toBe("pending");
    await t.reply(th, "no", { type: "decline", re: f1.id, reason: "refused" });
    const c = classifyReply(await t.getThread(1))!;
    expect(c.status).toBe("decline");
    expect(c.reply!.body).toBe("no");
  });

  it("ignores messages from others and messages without metadata", async () => {
    const { t, th } = await scenario();
    await t.as("carol").reply(th, "x", { type: "message" });
    t.as("bob").humanComment(th, "human note");
    const full = await t.getThread(1);
    expect(classifyReply(full)!.awaiting.id).toBe(th.id);
  });

  it("computes unanswered sender messages after last re", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "message" });
    await t.as("alice").reply(th, "a", { type: "reply", re: f1.id });
    const f2 = await t.as("bob").reply(th, "f2", { type: "message" });
    const f3 = await t.reply(th, "f3", { type: "message" });
    expect(unansweredSenderMessages(await t.getThread(1), "alice").map((m) => m.id)).toEqual([f2.id, f3.id]);
  });

  it("keeps newer message pending when responder replies out of order to an older one", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "message" });
    const f2 = await t.reply(th, "f2", { type: "message" });
    await t.as("alice").reply(th, "a2", { type: "reply", re: f2.id });
    await t.reply(th, "a1", { type: "reply", re: f1.id }); // late reply to an older message
    const f3 = await t.as("bob").reply(th, "f3", { type: "message" });
    const full = await t.getThread(1);
    expect(classifyReply(full)!.status).toBe("pending");
    expect(unansweredSenderMessages(full, "alice").map((m) => m.id)).toEqual([f3.id]);
    expect(pendingFor(full, "alice")).not.toBeNull();
  });

  it("falls back to time when every re target was deleted", async () => {
    const { t, th } = await scenario();
    const f1 = await t.reply(th, "f1", { type: "message" });
    await t.as("alice").reply(th, "a", { type: "reply", re: f1.id });
    const f2 = await t.as("bob").reply(th, "f2", { type: "message" });
    t.deleteComment(f1.id);
    expect(unansweredSenderMessages(await t.getThread(1), "alice").map((m) => m.id)).toEqual([f2.id]);
  });

  it("matches logins case-insensitively", async () => {
    const t = new FakeTransport("Bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "ALICE" });
    await t.as("alice").reply(th, "a", { type: "reply", re: th.id });
    const f = await t.as("Bob").reply(th, "f", { type: "message" });
    const full = await t.getThread(1);
    expect(unansweredSenderMessages(full, "Alice").map((m) => m.id)).toEqual([f.id]);
    expect(pendingFor(full, "aLiCe")).not.toBeNull();
  });

  it("returns null for non-huddle threads and openings without to", async () => {
    const t = new FakeTransport("bob");
    await t.createThread("kb", "entry", "body", { type: "kb" });
    expect(classifyReply(await t.getThread(1))).toBeNull();
    await t.createThread("messages", "q", "body", { type: "message" });
    expect(messageMeta(await t.getThread(2))).toBeNull();
    expect(classifyReply(await t.getThread(2))).toBeNull();
    await t.createThread("kb", "q", "body", { type: "message", to: "alice" });
    expect(messageMeta(await t.getThread(3))).toBeNull();
  });
});
