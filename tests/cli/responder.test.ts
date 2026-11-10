import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPO_CONFIG, parseMachineConfig } from "../../src/config.js";
import { pausedFile } from "../../src/core/paths.js";
import { FakeTransport } from "../../src/transport/fake.js";
import type { Ctx } from "../../src/cli/context.js";
import { pause, resume, retract } from "../../src/cli/responder.js";

const mkCtx = (transport: FakeTransport, me: string): Ctx => ({ root: process.cwd(), repo: DEFAULT_REPO_CONFIG, machine: parseMachineConfig(null), transport, me, slug: "o/r", publicThreads: false });

let out: string[];
let oldHome: string | undefined;
beforeEach(() => {
  oldHome = process.env.HUDDLE_HOME;
  process.env.HUDDLE_HOME = mkdtempSync(path.join(os.tmpdir(), "huddle-test-"));
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => (out.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HUDDLE_HOME;
  else process.env.HUDDLE_HOME = oldHome;
});

describe("pause / resume", () => {
  it("creates and removes the paused file", async () => {
    expect(await pause()).toBe(0);
    expect(existsSync(pausedFile())).toBe(true);
    expect(await resume()).toBe(0);
    expect(existsSync(pausedFile())).toBe(false);
  });
});

describe("retract", () => {
  const setup = async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("ask", "q", "why?", { type: "ask", to: "alice" });
    return { t, th };
  };

  it("posts a refused decline then deletes when retracting the answer to the latest question", async () => {
    const { t, th } = await setup();
    const a = await t.as("alice").reply(th, "ans", { type: "answer", re: th.id });
    expect(await retract(mkCtx(t, "alice"), a.id)).toBe(0);
    const after = await t.getThread(th.number);
    expect(after.messages.some((m) => m.id === a.id)).toBe(false);
    const last = after.messages.at(-1)!;
    expect(last.meta).toMatchObject({ type: "decline", re: th.id, reason: "refused" });
    expect(last.author).toBe("alice");
  });

  it("only deletes when the answer is to an older question", async () => {
    const { t, th } = await setup();
    const a = await t.as("alice").reply(th, "ans", { type: "answer", re: th.id });
    await t.as("bob").reply(th, "more", { type: "followup" });
    const before = (await t.getThread(th.number)).messages.length;
    await retract(mkCtx(t, "alice"), a.id);
    const after = await t.getThread(th.number);
    expect(after.messages.length).toBe(before - 1);
    expect(after.messages.some((m) => m.meta?.type === "decline")).toBe(false);
  });

  it("rejects retracting someone else's message", async () => {
    const { t, th } = await setup();
    const f = await t.as("bob").reply(th, "more", { type: "followup" });
    await expect(retract(mkCtx(t, "alice"), f.id)).rejects.toThrow(/only retract replies you posted/);
  });

  it("prints the re-answer note when retracting a decline", async () => {
    const { t, th } = await setup();
    const d = await t.as("alice").reply(th, "no", { type: "decline", re: th.id, reason: "refused" });
    await retract(mkCtx(t, "alice"), d.id);
    expect(out.join("")).toContain("answered automatically again");
  });
});
