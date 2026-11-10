import { appendFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, findResumableSession, hourlyInvocations, lastAttemptDiscarded, readRecentAudit, type AuditEntry } from "../../src/core/audit.js";

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  time: new Date().toISOString(), threadId: "T1", threadUrl: "u", re: "r", backend: "claude", invokedAgent: true,
  sessionId: null, resumed: false, postedType: null, postedText: null, redactions: [], discardReason: null, durationMs: 1, ...over,
});

describe("audit", () => {
  it("appends and reads back recent entries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "huddle-audit-"));
    await appendAudit(entry({ sessionId: "S1" }), dir);
    await appendAudit(entry({ sessionId: "S2", backend: "codex" }), dir);
    const all = await readRecentAudit(7, new Date(), dir);
    expect(all.map((e) => e.sessionId)).toEqual(["S1", "S2"]);
  });

  it("counts only agent invocations within the last hour", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const es = [
      entry({ time: "2026-11-10T11:30:00Z" }),
      entry({ time: "2026-11-10T11:59:00Z", invokedAgent: false }),
      entry({ time: "2026-11-10T10:30:00Z" }),
    ];
    expect(hourlyInvocations(es, now)).toBe(1);
  });

  it("finds latest session per thread and backend", () => {
    const es = [entry({ sessionId: "S1" }), entry({ sessionId: null }), entry({ threadId: "T2", sessionId: "X" }), entry({ backend: "codex", sessionId: "C" })];
    expect(findResumableSession(es, "T1", "claude")).toBe("S1");
    expect(findResumableSession(es, "T1", "codex")).toBe("C");
    expect(findResumableSession(es, "T3", "claude")).toBeNull();
  });

  it("reports whether the last agent attempt was discarded", () => {
    expect(lastAttemptDiscarded([entry({ discardReason: "new_followup" })], "T1")).toBe(true);
    expect(lastAttemptDiscarded([entry({ discardReason: "new_followup" }), entry({})], "T1")).toBe(false);
    expect(lastAttemptDiscarded([entry({ discardReason: "x" }), entry({ invokedAgent: false })], "T1")).toBe(true);
    expect(lastAttemptDiscarded([entry({ discardReason: "x" }), entry({ error: "boom" })], "T1")).toBe(true);
    expect(lastAttemptDiscarded([entry({}), entry({ discardReason: "post_error", error: "post failed: x" })], "T1")).toBe(true);
  });

  it("skips corrupted lines", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "huddle-audit-"));
    await appendAudit(entry({ sessionId: "S1" }), dir);
    const file = path.join(dir, readdirSync(dir)[0]);
    appendFileSync(file, "{broken\n");
    await appendAudit(entry({ sessionId: "S2" }), dir);
    expect((await readRecentAudit(7, new Date(), dir)).map((e) => e.sessionId)).toEqual(["S1", "S2"]);
  });

  it("caps large fields and uses private permissions", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "huddle-audit-")), "log");
    await appendAudit(entry({ prompt: "p".repeat(300_000), rawOutput: "short" }), dir);
    const [e] = await readRecentAudit(7, new Date(), dir);
    expect(e.prompt!.length).toBeLessThan(200_100);
    expect(e.prompt!.endsWith("…[truncated]")).toBe(true);
    expect(e.rawOutput).toBe("short");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, readdirSync(dir)[0])).mode & 0o777).toBe(0o600);
  });
});
