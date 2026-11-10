import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { auditDir } from "./paths.js";
import type { MsgType } from "./types.js";
import type { RedactionHit } from "./redact.js";

export interface AuditEntry {
  time: string;
  threadId: string;
  threadUrl: string;
  re: string;
  backend: string;
  invokedAgent: boolean;      // false: message sent without invoking the agent (does not count toward the hourly limit)
  sessionId: string | null;   // recorded only for successful invocations; null for failed ones
  resumed: boolean;
  prompt?: string;
  rawOutput?: string;
  stderr?: string;
  postedType: MsgType | null;
  postedText: string | null;
  redactions: RedactionHit[];
  discardReason: string | null;
  durationMs: number;
  error?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MAX_FIELD = 200_000;
const cap = (s: string | undefined | null): string | undefined | null =>
  typeof s === "string" && s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[truncated]` : s;

/** The audit log holds private, pre-redaction content: directory 0700, files 0600, and large fields are length-capped. */
export async function appendAudit(e: AuditEntry, dir = auditDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const capped: AuditEntry = { ...e, prompt: cap(e.prompt) as string | undefined, rawOutput: cap(e.rawOutput) as string | undefined, stderr: cap(e.stderr) as string | undefined, postedText: cap(e.postedText) as string | null };
  const file = path.join(dir, `${dayKey(new Date(e.time))}.jsonl`);
  await appendFile(file, `${JSON.stringify(capped)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

/** Returns records from the last `days` days (including today) in chronological order, skipping corrupted lines. */
export async function readRecentAudit(days: number, now: Date, dir = auditDir()): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for (let i = days; i >= 0; i--) {
    let txt: string;
    try {
      txt = await readFile(path.join(dir, `${dayKey(new Date(now.getTime() - i * 86400_000))}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip corrupted lines
      }
    }
  }
  return out;
}

export const hourlyInvocations = (entries: AuditEntry[], now: Date): number =>
  entries.filter((e) => e.invokedAgent && now.getTime() - Date.parse(e.time) < 3600_000).length;

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** The session id is passed to the backend as a command-line argument, so only a conservative character set is accepted and it must not start with -. */
export const isSafeSessionId = (id: string): boolean => SAFE_SESSION_ID.test(id) && !id.startsWith("-");

export function findResumableSession(entries: AuditEntry[], threadId: string, backend: string): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.threadId === threadId && e.backend === backend && e.sessionId) return isSafeSessionId(e.sessionId) ? e.sessionId : null;
  }
  return null;
}

/** Whether the result of the thread's most recent successful agent invocation (skipping failed ones) was discarded (used for the continuation prompt hint). */
export function lastAttemptDiscarded(entries: AuditEntry[], threadId: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.threadId === threadId && e.invokedAgent && (!e.error || e.discardReason)) return e.discardReason !== null;
  }
  return false;
}
