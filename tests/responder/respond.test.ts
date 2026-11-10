import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG, type RepoConfig } from "../../src/config.js";
import { appendAudit, readRecentAudit } from "../../src/core/audit.js";
import { claudeBackend } from "../../src/responder/backends/claude.js";
import { MARKER } from "../../src/responder/prompt.js";
import { PublicRepoError } from "../../src/errors.js";
import { respondOnce, serve, type RespondDeps } from "../../src/responder/respond.js";
import type { RunResult, RunSpec } from "../../src/responder/runner.js";
import { FakeTransport } from "../../src/transport/fake.js";

const machine = { permission_mode: "auto" as const, extra_context_dirs: [] };
const ok = (out: object, sessionId = "S1"): RunResult => ({
  exitCode: 0, stderr: "", timedOut: false, truncated: false, durationMs: 5,
  stdout: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(out), session_id: sessionId }),
});
const answer = (body = "because X") => ({ kind: "answer", body_md: body, confidence: "high", sources: ["a.ts:1"], decline_reason: null });
const fail: RunResult = { exitCode: 1, stdout: "", stderr: "No conversation found", timedOut: false, truncated: false, durationMs: 5 };

function setup(limits: Partial<RepoConfig["limits"]> = {}) {
  const t = new FakeTransport("bob", Date.now());
  t.writers.add("bob");
  t.writers.add("alice");
  const dir = mkdtempSync(path.join(tmpdir(), "huddle-respond-"));
  const calls: RunSpec[] = [];
  let script: (spec: RunSpec, i: number) => Promise<RunResult> | RunResult = () => ok(answer());
  const deps: RespondDeps = {
    transport: t, me: "alice", machine, backend: claudeBackend(machine), cwd: "/tmp", auditDir: dir,
    repo: { ...DEFAULT_REPO_CONFIG, limits: { ...DEFAULT_REPO_CONFIG.limits, ...limits } },
    isPaused: () => false, log: (m) => { if (process.env.DBG) console.log(m); },
    run: async (spec) => {
      calls.push(spec);
      return script(spec, calls.length - 1);
    },
  };
  return { t, dir, calls, deps, setScript: (s: typeof script) => { script = s; } };
}

async function askAlice(t: FakeTransport, text = "why?") {
  const th = await t.as("bob").createThread("ask", "q", text, { type: "ask", to: "alice" });
  t.as("alice");
  return th;
}

describe("respondOnce", () => {
  it("answers a directed question with re, footer and audit", async () => {
    const { t, deps, calls, dir } = setup();
    const th = await askAlice(t);
    await respondOnce(deps);
    const full = await t.getThread(th.number);
    const a = full.messages[1];
    expect(a.author).toBe("alice");
    expect(a.meta).toEqual({ type: "answer", re: th.id });
    expect(a.body).toContain("because X");
    expect(a.body).toContain("Answered automatically");
    expect(calls[0].stdin.startsWith(MARKER)).toBe(true);
    const audit = await readRecentAudit(1, new Date(), dir);
    expect(audit.at(-1)).toMatchObject({ postedType: "answer", sessionId: "S1", invokedAgent: true });
    await respondOnce(deps);
    expect(calls.length).toBe(1); // already replied; no repeat
  });

  it("turns low confidence into decline and redacts secrets", async () => {
    const { t, deps, setScript } = setup();
    const th = await askAlice(t);
    setScript(() => ok({ ...answer(`token ghp_${"A".repeat(36)}`), confidence: "low" }));
    await respondOnce(deps);
    const m = (await t.getThread(th.number)).messages[1];
    expect(m.meta).toEqual({ type: "decline", re: th.id, reason: "low_confidence" });
    expect(m.body).toContain("[REDACTED:github-token]");
  });

  it("resumes the same session for followups after clarify", async () => {
    const { t, deps, calls, setScript } = setup();
    const th = await askAlice(t);
    setScript(() => ok({ kind: "clarify", body_md: "TTL or manual?", confidence: "medium", sources: [], decline_reason: null }));
    await respondOnce(deps);
    const f = await t.as("bob").reply(th, "TTL", { type: "followup" });
    t.as("alice");
    setScript(() => ok(answer("TTL is 5m"), "S1"));
    await respondOnce(deps);
    expect(calls[1].argv.slice(-2)).toEqual(["--resume", "S1"]);
    expect(calls[1].stdin).toContain("TTL");
    expect(calls[1].stdin).not.toContain(MARKER);
    expect(calls[1].stdin).not.toContain("why?");
    const last = (await t.getThread(th.number)).messages.at(-1)!;
    expect(last.meta).toEqual({ type: "answer", re: f.id });
  });

  it("discards the draft when a followup arrives meanwhile, then answers all on the next round", async () => {
    const { t, deps, calls, dir, setScript } = setup();
    const th = await askAlice(t);
    setScript(async () => {
      await t.as("bob").reply(th, "also: what about Y?", { type: "followup" });
      t.as("alice");
      return ok(answer("stale draft"));
    });
    await respondOnce(deps);
    expect((await t.getThread(th.number)).messages.filter((m) => m.author === "alice")).toHaveLength(0);
    expect((await readRecentAudit(1, new Date(), dir)).at(-1)!.discardReason).toBe("new_followup");

    setScript(() => ok(answer("X and Y")));
    await respondOnce(deps);
    expect(calls[1].stdin).toContain("your previous draft was not sent");
    expect(calls[1].stdin).toContain("what about Y");
    const full = await t.getThread(th.number);
    expect(full.messages.at(-1)!.meta).toEqual({ type: "answer", re: full.messages[1].id });
  });

  it("posts rate_limited decline once when the per-thread limit is reached", async () => {
    const { t, deps, calls } = setup({ rounds_per_thread: 1 });
    const th = await askAlice(t);
    await respondOnce(deps);
    await t.as("bob").reply(th, "more", { type: "followup" });
    t.as("alice");
    await respondOnce(deps);
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    const declines = (await t.getThread(th.number)).messages.filter((m) => m.meta?.type === "decline");
    expect(declines).toHaveLength(1);
    expect(declines[0].meta!.reason).toBe("rate_limited");
  });

  it("skips silently when the hourly limit is reached", async () => {
    const { t, deps, calls } = setup({ answers_per_hour: 1 });
    await askAlice(t, "q1");
    const th2 = await askAlice(t, "q2");
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    expect((await t.getThread(th2.number)).messages).toHaveLength(1);
  });

  it("enforces the hourly limit across retries without posting", async () => {
    const { t, deps, calls, setScript } = setup({ answers_per_hour: 1 });
    const th = await askAlice(t);
    setScript(() => ({ ...ok(answer()), stdout: "garbage" }));
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
  });

  it("caps retries of a resumable session at the remaining budget", async () => {
    const { t, deps, calls, dir, setScript } = setup({ answers_per_hour: 2 });
    const th = await askAlice(t);
    await appendAudit(
      { time: new Date().toISOString(), threadId: th.id, threadUrl: th.url, re: "x", backend: "claude", invokedAgent: false, sessionId: "OLD", resumed: false, postedType: null, postedText: null, redactions: [], discardReason: null, durationMs: 0 },
      dir,
    );
    setScript(() => fail);
    await respondOnce(deps);
    expect(calls).toHaveLength(2);
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
  });

  it("falls back to a fresh session when resume fails", async () => {
    const { t, deps, calls, dir, setScript } = setup();
    const th = await askAlice(t);
    await appendAudit(
      { time: new Date().toISOString(), threadId: th.id, threadUrl: th.url, re: "x", backend: "claude", invokedAgent: false, sessionId: "OLD", resumed: false, postedType: null, postedText: null, redactions: [], discardReason: null, durationMs: 0 },
      dir,
    );
    setScript((spec) => (spec.argv.includes("--resume") ? fail : ok(answer(), "NEW")));
    await respondOnce(deps);
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin.startsWith(MARKER)).toBe(true);
    expect((await t.getThread(th.number)).messages[1].meta!.type).toBe("answer");
    const rows = (await readRecentAudit(1, new Date(), dir)).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ resumed: true, sessionId: null, postedType: null });
    expect(rows[0].error).toBeTruthy();
    expect(rows[1]).toMatchObject({ resumed: false, sessionId: "NEW", postedType: "answer" });
  });

  it("declines with timeout and with error after retries", async () => {
    const { t, deps, calls, setScript } = setup();
    const th = await askAlice(t);
    setScript(() => ({ exitCode: null, stdout: "", stderr: "", timedOut: true, truncated: false, durationMs: 1 }));
    await respondOnce(deps);
    expect((await t.getThread(th.number)).messages[1].meta).toEqual({ type: "decline", re: th.id, reason: "timeout" });
    expect(calls).toHaveLength(1);

    const th2 = await askAlice(t, "q2");
    setScript(() => fail);
    await respondOnce(deps);
    expect(calls).toHaveLength(3);
    expect((await t.getThread(th2.number)).messages[1].meta).toEqual({ type: "decline", re: th2.id, reason: "error" });
  });

  it("discards the draft and posts nothing when paused during the run", async () => {
    const { t, deps, dir } = setup();
    const th = await askAlice(t);
    let paused = false;
    await respondOnce({ ...deps, isPaused: () => paused, run: async () => { paused = true; return ok(answer()); } });
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
    expect((await readRecentAudit(1, new Date(), dir)).at(-1)!.discardReason).toBe("paused");
    let p2 = false;
    await respondOnce({ ...deps, isPaused: () => p2, run: async () => { p2 = true; return fail; } });
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
  });

  it("redacts secrets in agent-provided sources", async () => {
    const { t, deps, setScript } = setup();
    const th = await askAlice(t);
    setScript(() => ok({ ...answer(), sources: [`cfg.ts?token=ghp_${"B".repeat(36)}`] }));
    await respondOnce(deps);
    const m = (await t.getThread(th.number)).messages[1];
    expect(m.body).not.toContain("ghp_BBBB");
    expect(m.body).toContain("[REDACTED:github-token]");
  });

  it("truncates over-long answers", async () => {
    const { t, deps, setScript } = setup();
    const th = await askAlice(t);
    setScript(() => ok(answer("x".repeat(70_000))));
    await respondOnce(deps);
    const m = (await t.getThread(th.number)).messages[1];
    expect(m.body.length).toBeLessThanOrEqual(60_000);
    expect(m.body).toContain("answer truncated");
  });

  it("writes exactly one post_error row when reply throws, and does not re-run the agent past the hourly cap", async () => {
    const { t, deps, calls, dir } = setup({ answers_per_hour: 1 });
    const th = await askAlice(t);
    const orig = t.reply.bind(t);
    t.reply = async () => { throw new Error("boom"); };
    await respondOnce(deps);
    t.reply = orig;
    const rows = await readRecentAudit(1, new Date(), dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ discardReason: "post_error", sessionId: "S1", postedType: null });
    expect(rows[0].error).toContain("post failed: boom");
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
  });

  it("writes a post_error row when the held-draft refetch throws", async () => {
    const { t, deps, calls, dir } = setup({ answers_per_hour: 1 });
    const th = await askAlice(t);
    const orig = t.getThread.bind(t);
    let n = 0;
    t.getThread = async (num) => {
      if (++n === 1) throw new Error("net down");
      return orig(num);
    };
    await respondOnce(deps);
    const rows = await readRecentAudit(1, new Date(), dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ discardReason: "post_error", sessionId: "S1" });
    expect(rows[0].error).toContain("refetch failed: net down");
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    expect((await t.getThread(th.number)).messages).toHaveLength(1);
  });

  it("backs off for 10 minutes after a post_error, then retries", async () => {
    const { t, deps, calls } = setup();
    await askAlice(t);
    const orig = t.reply.bind(t);
    t.reply = async () => { throw new Error("boom"); };
    await respondOnce(deps);
    t.reply = orig;
    await respondOnce(deps);
    expect(calls).toHaveLength(1);
    await respondOnce({ ...deps, now: () => new Date(Date.now() + 11 * 60_000) });
    expect(calls).toHaveLength(2);
  });

  it("one failing thread does not stop the next", async () => {
    const { t, deps } = setup();
    const a = await askAlice(t, "q1");
    const b = await askAlice(t, "q2");
    const orig = t.reply.bind(t);
    t.reply = async (th, ...rest) => {
      if (th.number === a.number) throw new Error("boom");
      return orig(th, ...rest);
    };
    await respondOnce(deps);
    expect((await t.getThread(a.number)).messages).toHaveLength(1);
    expect((await t.getThread(b.number)).messages).toHaveLength(2);
  });

  it("does nothing when paused or when the asker lacks write access", async () => {
    const { t, deps, calls } = setup();
    await askAlice(t);
    await respondOnce({ ...deps, isPaused: () => true });
    expect(calls).toHaveLength(0);
    t.writers.delete("bob");
    await respondOnce(deps);
    expect(calls).toHaveLength(0);
  });

  it("ends serve when beforeRound rejects", async () => {
    const { deps } = setup();
    await expect(serve({ ...deps, beforeRound: async () => { throw new PublicRepoError("went public"); } }, 1)).rejects.toThrow("went public");
  });

  it("runs beforeRound every round and survives transient errors", async () => {
    const { deps } = setup();
    let n = 0;
    const beforeRound = async () => {
      n++;
      if (n === 2) throw new Error("network");
      if (n === 4) throw new PublicRepoError("stop");
    };
    await expect(serve({ ...deps, beforeRound }, 1)).rejects.toThrow("stop");
    expect(n).toBe(4);
  });

  it("passes publicThread into the prompt", async () => {
    const { t, deps, calls } = setup();
    await askAlice(t);
    await respondOnce({ ...deps, publicThread: true });
    expect(calls[0].stdin).toContain("This thread is PUBLIC");
  });

  it("discards the draft when the repo turns public while the agent runs", async () => {
    const { t, deps, setScript } = setup();
    await askAlice(t);
    setScript(() => { t.private = false; return ok(answer()); });
    await expect(respondOnce(deps)).rejects.toThrow(PublicRepoError);
    expect((await t.getThread(1)).messages).toHaveLength(1);
    const audit = await readRecentAudit(7, new Date(), deps.auditDir!);
    expect(audit.at(-1)?.discardReason).toBe("repo_public");
  });

  it("redrafts under the PUBLIC rule when public is allowed but the draft was not", async () => {
    const { t, deps, setScript, calls } = setup();
    deps.repo = { ...deps.repo, public: true };
    await askAlice(t);
    setScript(() => { t.private = false; return ok(answer()); });
    await respondOnce(deps);
    expect((await t.getThread(1)).messages).toHaveLength(1);
    expect(deps.publicThread).toBe(true);
    await respondOnce(deps);
    expect(calls.at(-1)!.stdin).toContain("This thread is PUBLIC");
    expect((await t.getThread(1)).messages).toHaveLength(2);
  });
});
