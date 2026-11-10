import { describe, expect, it } from "vitest";
import { codexBackend } from "../../src/responder/backends/codex.js";
import type { RunResult } from "../../src/responder/runner.js";

const cfg = { permission_mode: "auto" as const, limits: { rounds_per_thread: 8, replies_per_hour: 20, timeout_minutes: 10 } };
const run = (stdout: string, exitCode: number | null = 0, timedOut = false): RunResult => ({ exitCode, stdout, stderr: "boom", timedOut, truncated: false, durationMs: 1 });
const lines = (evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n");

// The thread.started / turn.* / error events were captured from codex-cli 0.162.1; the agent_message shape follows the expected format (the account had no usable model, so a successful round could not be captured).
const events = lines([
  { type: "thread.started", thread_id: "T-123" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: '{"kind":"answer"}' } },
  { type: "turn.completed" },
]);
const failedEvents = lines([
  { type: "thread.started", thread_id: "T-9" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `x` not found." } },
  { type: "turn.started" },
  { type: "error", message: "model_not_found" },
  { type: "turn.failed", error: { message: "model_not_found" } },
]);

describe("codex backend", () => {
  it("builds argv for fresh and resumed runs", () => {
    const b = codexBackend(cfg);
    expect(b.argv({ resumeSessionId: null })).toEqual(["codex", "exec", "--json", "--sandbox", "danger-full-access", "-"]);
    expect(b.argv({ resumeSessionId: "T-1" })).toEqual(["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', "T-1", "-"]);
  });

  it("extracts thread id and last agent message, ignoring noise", () => {
    expect(codexBackend(cfg).parse(run("warn: x\n" + events))).toEqual({ sessionId: "T-123", text: '{"kind":"answer"}' });
  });

  it("throws on missing message, failure, timeout and spawn error", () => {
    const b = codexBackend(cfg);
    expect(() => b.parse(run('{"type":"thread.started","thread_id":"x"}'))).toThrow(/no agent message/);
    expect(() => b.parse(run(failedEvents, 0))).toThrow(/model_not_found/);
    expect(() => b.parse(run(failedEvents, 1))).toThrow(/exit code 1.*model_not_found.*stderr: boom/);
    expect(() => b.parse(run(events, null, true))).toThrow(/timed out/);
    expect(() => b.parse({ ...run(""), spawnError: "ENOENT" })).toThrow(/Cannot start/);
  });
});

describe("codex backend event edge cases", () => {
  it("uses the last agent_message when there are several", () => {
    const evs = lines([
      { type: "thread.started", thread_id: "T-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "first" } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "last" } },
    ]);
    expect(codexBackend(cfg).parse(run(evs))).toEqual({ sessionId: "T-1", text: "last" });
  });

  it("returns a null sessionId without thread.started", () => {
    const evs = lines([{ type: "item.completed", item: { id: "i0", type: "agent_message", text: "hi" } }]);
    expect(codexBackend(cfg).parse(run(evs))).toEqual({ sessionId: null, text: "hi" });
  });
});

describe("codex session id hardening", () => {
  it("falls back to a fresh run for unsafe session ids", () => {
    const b = codexBackend(cfg);
    expect(b.argv({ resumeSessionId: "--evil" })).toEqual(["codex", "exec", "--json", "--sandbox", "danger-full-access", "-"]);
    expect(b.argv({ resumeSessionId: "a b" })).not.toContain("resume");
  });
});
