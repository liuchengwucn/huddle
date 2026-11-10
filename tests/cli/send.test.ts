import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPO_CONFIG, parseMachineConfig } from "../../src/config.js";
import { signature } from "../../src/core/signature.js";
import { FakeTransport } from "../../src/transport/fake.js";
import type { Ctx } from "../../src/cli/context.js";
import { followUp, makeTitle, parseSendArgs, send, waitCmd } from "../../src/cli/send.js";

function mkCtx(transport: FakeTransport, me: string): Ctx {
  return { root: process.cwd(), repo: DEFAULT_REPO_CONFIG, machine: parseMachineConfig(null), transport, me, slug: "o/r", publicThreads: false };
}

let out: string;
let err: string;
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("send helpers", () => {
  it("builds titles from the first non-empty line", () => {
    expect(makeTitle("\n  缓存为什么   失效？\n细节")).toBe("缓存为什么 失效？");
    expect([...makeTitle("长".repeat(100))].length).toBe(81);
    expect(makeTitle("  \n ")).toBe("huddle message");
  });

  it("validates send arguments", () => {
    expect(parseSendArgs("hello", undefined, "alice")).toEqual({ message: "hello" });
    expect(parseSendArgs("12", "more", undefined)).toEqual({ ref: "12", message: "more" });
    expect(() => parseSendArgs("12", "more", "alice")).toThrow(/takes only the message.*Usage: huddle send/);
    expect(() => parseSendArgs("hello", undefined, undefined)).toThrow(/Without --to, pass both <thread> and <message>.*Usage: huddle send/);
  });
});

describe("send", () => {
  it("opens a message thread, notes it on stderr, then waits", async () => {
    const t = new FakeTransport("bob");
    t.writers.add("alice");
    const code = await send(mkCtx(t, "bob"), "Heads-up: cache API changed\ndetails", { to: "@alice", wait: 0 });
    expect(code).toBe(2);
    const th = await t.getThread(1);
    expect(th.category).toBe("messages");
    expect(th.title).toBe("Heads-up: cache API changed");
    expect(th.messages[0].meta).toEqual({ type: "message", to: "alice" });
    expect(th.messages[0].body).toBe("Heads-up: cache API changed\ndetails" + signature("Sent by bob's agent"));
    expect(err).toContain("[huddle] Sent to alice: #1 https://fake.test/discussions/1");
    expect(out).toContain("huddle wait 1");
  });

  it("rejects empty messages and is blocked for responders", async () => {
    const t = new FakeTransport("bob");
    t.writers.add("alice");
    await expect(send(mkCtx(t, "bob"), "  ", { to: "alice", wait: 0 })).rejects.toThrow(/must not be empty/);
    vi.stubEnv("HUDDLE_RESPONDER", "1");
    await expect(send(mkCtx(t, "bob"), "hi", { to: "alice", wait: 0 })).rejects.toThrow(/HUDDLE_RESPONDER/);
    await expect(followUp(mkCtx(t, "bob"), "1", "hi", { wait: 0 })).rejects.toThrow(/HUDDLE_RESPONDER/);
  });
});

describe("followUp", () => {
  const setup = async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    return { t, th };
  };

  it("rejects follow-ups from someone other than the sender", async () => {
    const { t, th } = await setup();
    await expect(followUp(mkCtx(t.as("alice"), "alice"), String(th.number), "x", { wait: 0 })).rejects.toThrow(/Only the sender bob/);
  });

  it("rejects non-message threads", async () => {
    const t = new FakeTransport("bob");
    await t.createThread("cards", "c", "body", { type: "card" });
    await expect(followUp(mkCtx(t, "bob"), "1", "x", { wait: 0 })).rejects.toThrow(/not a huddle message thread/);
  });

  it("warns on stderr when the thread is public", async () => {
    const { t, th } = await setup();
    await followUp({ ...mkCtx(t, "bob"), publicThreads: true }, String(th.number), "more", { wait: 0 });
    expect(err).toContain("huddle: note: o/r is public; this thread is visible to everyone. Do not include private information.");
  });

  it("rejects follow-ups on closed threads", async () => {
    const { t, th } = await setup();
    t.closeThread(th);
    await expect(followUp(mkCtx(t, "bob"), String(th.number), "x", { wait: 0 })).rejects.toThrow(/is closed; use huddle send --to/);
  });

  it("posts a message after an earlier reply and waits for the new reply", async () => {
    const { t, th } = await setup();
    await t.as("alice").reply(th, "ans", { type: "reply", re: th.id });
    const code = await followUp(mkCtx(t.as("bob"), "bob"), String(th.number), "more", { wait: 0 });
    expect(code).toBe(2);
    const last = (await t.getThread(th.number)).messages.at(-1)!;
    expect(last.meta).toEqual({ type: "message" });
    expect(last.body).toBe("more" + signature("Sent by bob's agent"));
  });
});

describe("waitCmd", () => {
  it("waits on the given thread", async () => {
    const t = new FakeTransport("bob");
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "reply", re: th.id });
    expect(await waitCmd(mkCtx(t.as("bob"), "bob"), "#1", { wait: 0 })).toBe(0);
    expect(out).toContain("because");
  });

  it("without a thread, picks the thread where I sent most recently", async () => {
    const t = new FakeTransport("bob", Date.now());
    const a = await t.createThread("messages", "a", "a?", { type: "message", to: "alice" });
    await t.createThread("messages", "b", "b?", { type: "message", to: "alice" });
    await t.createThread("messages", "c", "c?", { type: "message", to: "alice" });
    await t.as("carol").createThread("messages", "d", "d?", { type: "message", to: "bob" });
    await t.as("bob").reply(a, "a again", { type: "message" }); // older thread, newest sent message: wins
    await t.as("alice").reply(a, "human-ish", { type: "message" }); // not mine: ignored
    expect(await waitCmd(mkCtx(t.as("bob"), "bob"), undefined, { wait: 0 })).toBe(2);
    expect(err).toContain("[huddle] Waiting on #1 https://fake.test/discussions/1");
    expect(out).toContain("thread #1");
  });

  it("without a thread, returns a reply that arrived before wait was run", async () => {
    const t = new FakeTransport("bob", Date.now());
    await t.createThread("messages", "old", "old?", { type: "message", to: "alice" });
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    await t.as("alice").reply(th, "because", { type: "reply", re: th.id });
    expect(await waitCmd(mkCtx(t.as("bob"), "bob"), undefined, { wait: 0 })).toBe(0);
    expect(out).toContain("because");
  });

  it("without a thread, reports a closed latest thread", async () => {
    const t = new FakeTransport("bob", Date.now());
    await t.createThread("messages", "old", "old?", { type: "message", to: "alice" });
    const th = await t.createThread("messages", "q", "why?", { type: "message", to: "alice" });
    t.closeThread(th);
    expect(await waitCmd(mkCtx(t.as("bob"), "bob"), undefined, { wait: 0 })).toBe(3);
  });

  it("without a thread, errors when I sent nothing", async () => {
    const t = new FakeTransport("bob", Date.now());
    await t.as("carol").createThread("messages", "d", "d?", { type: "message", to: "bob" });
    await expect(waitCmd(mkCtx(t.as("bob"), "bob"), undefined, { wait: 0 })).rejects.toThrow(
      "You have sent no message in the last 7 days. Pass a thread number.",
    );
  });
});
