import { describe, expect, it } from "vitest";
import { pendingFor, threadRoundsUsed } from "../../src/core/pending.js";
import { FakeTransport } from "../../src/transport/fake.js";

describe("pendingFor", () => {
  it("is pending only for the addressed responder", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "Alice" });
    const full = await t.getThread(th.number);
    expect(pendingFor(full, "alice")?.last.id).toBe(th.id);
    expect(pendingFor(full, "carol")).toBeNull();
    expect(pendingFor(full, "bob")).toBeNull();
  });

  it("clears after a reply with matching re and re-opens on follow-up", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "a", { type: "reply", re: th.id });
    expect(pendingFor(await t.getThread(1), "alice")).toBeNull();
    const f = await t.as("bob").reply(th, "more?", { type: "message" });
    const p = pendingFor(await t.getThread(1), "alice")!;
    expect(p.last.id).toBe(f.id);
    expect(p.unanswered.map((m) => m.id)).toEqual([f.id]);
    expect(threadRoundsUsed(await t.getThread(1), "alice")).toBe(1);
  });

  it("decline also counts as replied", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "no", { type: "decline", re: th.id, reason: "refused" });
    expect(pendingFor(await t.getThread(1), "alice")).toBeNull();
  });

  it("is not pending when closed or outside the messages category", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    t.closeThread(th);
    expect(pendingFor(await t.getThread(1), "alice")).toBeNull();
    await t.createThread("cards", "q2", "why?", { type: "message", to: "alice" });
    expect(pendingFor(await t.getThread(2), "alice")).toBeNull();
  });

  it("ignores follow-ups from people other than the sender", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "a", { type: "reply", re: th.id });
    await t.as("carol").reply(th, "me too", { type: "message" });
    expect(pendingFor(await t.getThread(1), "alice")).toBeNull();
  });
});
