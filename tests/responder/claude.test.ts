import { describe, expect, it } from "vitest";
import { claudeBackend } from "../../src/responder/backends/claude.js";
import type { RunResult } from "../../src/responder/runner.js";

const cfg = { permission_mode: "auto" as const, extra_context_dirs: [], command: ["/x/wrap", "--flag"] };
const run = (stdout: string, exitCode: number | null = 0, timedOut = false): RunResult => ({ exitCode, stdout, stderr: "boom", timedOut, truncated: false, durationMs: 1 });

describe("claude backend", () => {
  it("builds argv after the configured command prefix", () => {
    const b = claudeBackend(cfg);
    const a = b.argv({ resumeSessionId: null });
    expect(a.slice(0, 3)).toEqual(["/x/wrap", "--flag", "-p"]);
    expect(a).toContain("--json-schema");
    expect(a[a.indexOf("--settings") + 1]).toBe('{"autoMemoryEnabled":false}');
    expect(a).not.toContain("--resume");
    expect(b.argv({ resumeSessionId: "S1" }).slice(-2)).toEqual(["--resume", "S1"]);
  });

  it("parses result JSON even with noise before it", () => {
    const b = claudeBackend(cfg);
    const json = JSON.stringify({ type: "result", is_error: false, result: '{"kind":"answer"}', session_id: "S9" });
    expect(b.parse(run(`banner line\n${json}\n`))).toEqual({ sessionId: "S9", text: '{"kind":"answer"}' });
  });

  it("prefers structured_output when present", () => {
    const b = claudeBackend(cfg);
    const json = JSON.stringify({ result: "", structured_output: { kind: "clarify" }, session_id: "S1" });
    expect(b.parse(run(json)).text).toBe('{"kind":"clarify"}');
  });

  it("throws on non-zero exit, missing JSON or is_error", () => {
    const b = claudeBackend(cfg);
    expect(() => b.parse(run("", 1))).toThrow(/exit code/);
    expect(() => b.parse(run("not json"))).toThrow();
    expect(() => b.parse(run(JSON.stringify({ is_error: true, result: "bad", session_id: "x" })))).toThrow(/error/);
  });

  it("reports result text on non-zero exit with JSON stdout", () => {
    const b = claudeBackend(cfg);
    const json = JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "rate limit hit", session_id: "x" });
    expect(() => b.parse(run(json, 1))).toThrow(/exit code 1: rate limit hit/);
    expect(() => b.parse(run("plain out", 2))).toThrow(/stderr: boom.*stdout: plain out/);
  });

  it("reports timeout", () => {
    expect(() => claudeBackend(cfg).parse(run("", null, true))).toThrow(/timed out/);
  });

  it("parses pretty-printed JSON", () => {
    const json = JSON.stringify({ result: "ok", session_id: "P1" }, null, 2);
    expect(claudeBackend(cfg).parse(run(`banner\n${json}\n`))).toEqual({ sessionId: "P1", text: "ok" });
  });
});

describe("session id hardening", () => {
  it("ignores unsafe session ids", () => {
    const b = claudeBackend({ permission_mode: "auto", extra_context_dirs: [] });
    for (const id of ["--dangerous", "-x", "a b", "a;b", "", "x".repeat(201)]) {
      expect(b.argv({ resumeSessionId: id })).not.toContain("--resume");
    }
    expect(b.argv({ resumeSessionId: "abc-123_X" })).toContain("--resume");
  });
});
