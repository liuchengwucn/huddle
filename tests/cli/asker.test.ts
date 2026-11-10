import { DEFAULT_REPO_CONFIG, parseMachineConfig } from "../../src/config.js";
import { FakeTransport } from "../../src/transport/fake.js";
import type { Ctx } from "../../src/cli/context.js";
import { reply, resolve } from "../../src/cli/asker.js";
import { describe, expect, it, vi } from "vitest";
import { isShortQuestion, makeTitle } from "../../src/cli/asker.js";

describe("asker helpers", () => {
  it("builds titles from the first non-empty line", () => {
    expect(makeTitle("\n  缓存为什么   失效？\n细节")).toBe("缓存为什么 失效？");
    expect([...makeTitle("长".repeat(100))].length).toBe(81);
  });

  it("flags short questions", () => {
    expect(isShortQuestion("为什么？")).toBe(true);
    const long =
      "我在改 src/cache.ts 的失效逻辑，目标是让配置变更后缓存能立即失效。已经尝试把 TTL 改短，也试过手动调用 invalidate，但集成测试仍然失败。" +
      "报错是 CacheMiss 在第 40 行抛出，我不确定这是不是设计如此，想知道原来为什么要在这里做二次校验，以及去掉它会不会影响别的模块。";
    expect(isShortQuestion(long)).toBe(false);
  });
});

function mkCtx(transport: FakeTransport, me: string): Ctx {
  return { root: process.cwd(), repo: DEFAULT_REPO_CONFIG, machine: parseMachineConfig(null), transport, me, slug: "o/r", publicThreads: false };
}

describe("asker commands", () => {
  const setup = async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
    return { t, th };
  };

  it("rejects reply from non-asker", async () => {
    const { t, th } = await setup();
    await expect(reply(mkCtx(t.as("alice"), "alice"), String(th.number), "x", { wait: 0 })).rejects.toThrow(/Only the asker/);
  });

  it("warns on stderr when the thread is public", async () => {
    const { t, th } = await setup();
    let err = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      err += String(s);
      return true;
    });
    try {
      await reply({ ...mkCtx(t, "bob"), publicThreads: true }, String(th.number), "more", { wait: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(err).toContain("huddle: note: o/r is public; this thread is visible to everyone. Do not include private information.");
  });

  it("rejects reply on closed thread", async () => {
    const { t, th } = await setup();
    await t.close(th, "resolved");
    await expect(reply(mkCtx(t, "bob"), String(th.number), "x", { wait: 0 })).rejects.toThrow(/is closed/);
  });

  it("unmarks an answered thread then posts the followup", async () => {
    const { t, th } = await setup();
    const a = await t.as("alice").reply(th, "ans", { type: "answer", re: th.id });
    await t.as("bob").markResolved(th, a.id);
    const code = await reply(mkCtx(t.as("bob"), "bob"), String(th.number), "more", { wait: 0 });
    expect(code).toBe(2);
    const after = await t.getThread(th.number);
    expect(after.answerId).toBeNull();
    expect(after.messages.at(-1)!.meta?.type).toBe("followup");
  });

  it("resolve fails without an answer and marks the latest answer otherwise", async () => {
    const { t, th } = await setup();
    await expect(resolve(mkCtx(t, "bob"), String(th.number))).rejects.toThrow(/has no answer yet/);
    await t.as("alice").reply(th, "a1", { type: "answer", re: th.id });
    const f = await t.as("bob").reply(th, "f", { type: "followup" });
    const a2 = await t.as("alice").reply(th, "a2", { type: "answer", re: f.id });
    expect(await resolve(mkCtx(t.as("bob"), "bob"), String(th.number))).toBe(0);
    expect((await t.getThread(th.number)).answerId).toBe(a2.id);
  });
});
