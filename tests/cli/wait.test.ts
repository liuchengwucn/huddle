import { describe, expect, it } from "vitest";
import { waitForReply } from "../../src/cli/wait.js";
import { FakeTransport } from "../../src/transport/fake.js";

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe("waitForReply", () => {
  it("returns exit codes by reply type", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "reply", re: th.id });
    const r = await waitForReply(t, 1, 10, clock());
    expect(r.code).toBe(0);
    expect(r.output).toContain("because");
    expect(r.output).toContain('[huddle] Thread #1 has a reply. To follow up: huddle send 1 "<text>".');

    const f = await t.as("bob").reply(th, "TTL", { type: "message" });
    await t.as("alice").reply(th, "dunno", { type: "decline", re: f.id, reason: "low_confidence" });
    const d = await waitForReply(t, 1, 10, clock());
    expect(d.code).toBe(3);
    expect(d.output).toContain("low_confidence");

    const f2 = await t.as("bob").reply(th, "again", { type: "message" });
    await t.as("alice").reply(th, "slow", { type: "decline", re: f2.id, reason: "timeout" });
    expect((await waitForReply(t, 1, 10, clock())).output).toContain("retry later with huddle send 1");
  });

  it("recovers from transient getThread failures and gives up after 3", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "reply", re: th.id });
    const flaky = (n: number) => {
      let left = n;
      return Object.create(t, { getThread: { value: async (x: number) => { if (left-- > 0) throw new Error("net"); return t.getThread(x); } } }) as FakeTransport;
    };
    expect((await waitForReply(flaky(2), 1, 10, { ...clock(), pollMs: 1000 })).code).toBe(0);
    await expect(waitForReply(flaky(3), 1, 10, { ...clock(), pollMs: 1000 })).rejects.toThrow(/Run huddle wait 1 later/);
    await expect(waitForReply(flaky(3), 1, undefined, { ...clock(), pollMs: 1000 })).rejects.toThrow(/Run huddle wait 1 later/);
  });

  it("times out with exit 2 when the latest sender message has no reply", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "old reply", { type: "reply", re: th.id });
    await t.as("bob").reply(th, "follow-up", { type: "message" });
    const c = clock();
    const r = await waitForReply(t, 1, 60, { ...c, pollMs: 15_000 });
    expect(r.code).toBe(2);
    expect(r.output).toContain("check later with huddle wait 1");
    expect(r.output).not.toContain("inbox");
    expect(c.now()).toBe(60_000);
  });

  it("without a wait limit keeps polling until a reply arrives", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    let now = 0;
    let polls = 0;
    const sleep = async (ms: number) => {
      now += ms;
      if (++polls === 1000) await t.as("alice").reply(th, "finally", { type: "reply", re: th.id });
    };
    const r = await waitForReply(t, 1, undefined, { now: () => now, sleep, pollMs: 15_000 });
    expect(r.code).toBe(0);
    expect(r.output).toContain("finally");
    expect(now).toBe(1000 * 15_000);
  });

  it("does not sleep past the deadline when getThread keeps failing", async () => {
    const t = new FakeTransport("bob");
    await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    const bad = Object.create(t, { getThread: { value: async () => { throw new Error("net"); } } }) as FakeTransport;
    const c = clock();
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); await c.sleep(ms); };
    await expect(waitForReply(bad, 1, 0, { now: c.now, sleep, pollMs: 15_000 })).rejects.toThrow(/Run huddle wait 1 later/);
    expect(slept).toEqual([]);
    const c2 = clock();
    const slept2: number[] = [];
    await expect(waitForReply(bad, 1, 5, { now: c2.now, sleep: async (ms) => { slept2.push(ms); await c2.sleep(ms); }, pollMs: 15_000 })).rejects.toThrow(/huddle wait 1/);
    expect(slept2).toEqual([5000]);
  });
});
