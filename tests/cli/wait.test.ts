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
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "answer", re: th.id });
    const r = await waitForReply(t, 1, 10, clock());
    expect(r.code).toBe(0);
    expect(r.output).toContain("because");

    const f = await t.as("bob").reply(th, "which one?", { type: "followup" });
    await t.as("alice").reply(th, "TTL or manual?", { type: "clarify", re: f.id });
    expect((await waitForReply(t, 1, 10, clock())).code).toBe(4);

    const f2 = await t.as("bob").reply(th, "TTL", { type: "followup" });
    await t.as("alice").reply(th, "dunno", { type: "decline", re: f2.id, reason: "low_confidence" });
    const d = await waitForReply(t, 1, 10, clock());
    expect(d.code).toBe(3);
    expect(d.output).toContain("low_confidence");
  });

  it("recovers from transient getThread failures and gives up after 3", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "answer", re: th.id });
    const flaky = (n: number) => {
      let left = n;
      return Object.create(t, { getThread: { value: async (x: number) => { if (left-- > 0) throw new Error("net"); return t.getThread(x); } } }) as FakeTransport;
    };
    expect((await waitForReply(flaky(2), 1, 10, { ...clock(), pollMs: 1000 })).code).toBe(0);
    await expect(waitForReply(flaky(3), 1, 10, { ...clock(), pollMs: 1000 })).rejects.toThrow(/Run huddle wait 1 later/);
  });

  it("times out with exit 2 when the latest asker message has no reply", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
    await t.as("alice").reply(th, "old answer", { type: "answer", re: th.id });
    await t.as("bob").reply(th, "followup", { type: "followup" });
    const c = clock();
    const r = await waitForReply(t, 1, 60, { ...c, pollMs: 15_000 });
    expect(r.code).toBe(2);
    expect(c.now()).toBe(60_000);
  });

  it("does not sleep past the deadline when getThread keeps failing", async () => {
    const t = new FakeTransport("bob");
    await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
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
