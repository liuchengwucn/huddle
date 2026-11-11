import type { MachineConfig, RepoConfig } from "../config.js";
import { appendAudit, findResumableSession, hourlyInvocations, lastAttemptDiscarded, readRecentAudit, type AuditEntry } from "../core/audit.js";
import { pendingFor, threadRoundsUsed, type Pending } from "../core/pending.js";
import { auditDir as defaultAuditDir } from "../core/paths.js";
import { redact } from "../core/redact.js";
import type { DeclineReason, Thread } from "../core/types.js";
import { PublicRepoError } from "../errors.js";
import { signature } from "../core/signature.js";
import type { Transport } from "../transport/types.js";
import type { Backend } from "./backends/types.js";
import { decide, parseAgentOutput, type Decision } from "./output.js";
import { buildContinuationPrompt, buildInitialPrompt, type PromptContext } from "./prompt.js";
import { runProcess, type RunResult, type RunSpec } from "./runner.js";

export interface RespondDeps {
  transport: Transport;
  me: string;
  repo: RepoConfig;
  machine: MachineConfig;
  backend: Backend;
  cwd: string;
  run?: (spec: RunSpec) => Promise<RunResult>;
  now?: () => Date;
  log?: (msg: string) => void;
  auditDir?: string;
  /** Runs before every serve round; a rejection ends serve. */
  beforeRound?: () => Promise<void>;
  publicThread?: boolean;
}

const POST_ERROR_BACKOFF_MS = 10 * 60_000;
const MAX_POST = 60_000;
const TRUNCATED_NOTE = "…(reply truncated; the full text is in the owner's local audit log)";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function respondOnce(deps: RespondDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[huddle] ${m}\n`));
  const now = deps.now ?? (() => new Date());
  const since = new Date(now().getTime() - 7 * 86400_000);
  const threads = await deps.transport.listUpdatedThreads("messages", since);
  threads.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  const audit = await readRecentAudit(7, now(), deps.auditDir ?? defaultAuditDir());
  for (const t of threads) {
    warnCorrupted(t, log);
    const p = pendingFor(t, deps.me);
    if (!p) continue;
    try {
      if (!(await deps.transport.hasWriteAccess(t.author))) {
        if (!warnedNoWrite.has(t.number)) {
          warnedNoWrite.add(t.number);
          log(`Sender ${t.author} of #${t.number} has no write access; ignoring.`);
        }
        continue;
      }
      await handleThread(deps, t, p, log, audit);
    } catch (e) {
      if (e instanceof PublicRepoError) throw e;
      log(`Failed to process #${t.number}: ${errMsg(e)}`);
    }
  }
}

const warnedNoWrite = new Set<number>();
const warnedRetracted = new Set<string>();
const warnedCorrupted = new Set<string>();
function warnCorrupted(t: Thread, log: (m: string) => void): void {
  for (const m of t.messages) {
    if (m.meta === null && m.body.trimStart().startsWith("<!-- huddle:v1") && !warnedCorrupted.has(m.id)) {
      warnedCorrupted.add(m.id);
      log(`A message in #${t.number} (${m.url}) has corrupted huddle metadata; treating it as a plain comment.`);
    }
  }
}

function footer(d: Decision, me: string, backend: string): string {
  const src = d.sources.length ? `\nSources: ${d.sources.join(", ")}` : "";
  if (d.type === "reply") return signature(`Replied automatically by ${me}'s agent (${backend})`, src);
  return signature(`Declined automatically (${d.reason}) by ${me}'s agent (${backend})`, `\n@${me} please confirm in person.`);
}

type Outcome =
  | { ok: true; decision: Decision; sessionId: string | null; entry: AuditEntry }
  | { ok: false; failure: "timeout" | "error" };

async function handleThread(deps: RespondDeps, t: Thread, p: Pending, log: (m: string) => void, audit: AuditEntry[]): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const dir = deps.auditDir ?? defaultAuditDir();
  const run = deps.run ?? runProcess;
  const { limits } = deps.machine;
  const base = { threadId: t.id, threadUrl: t.url, re: p.last.id, backend: deps.backend.name, covers: p.unanswered.map((m) => m.id) };

  const write = async (e: AuditEntry) => {
    await appendAudit(e, dir);
    audit.push(e);
  };

  const postDecline = async (thread: Thread, reason: DeclineReason, notice: string, extra: Partial<AuditEntry> = {}) => {
    const text = notice + signature(`Posted automatically for ${deps.me}`);
    await deps.transport.reply(thread, text, { type: "decline", re: p.last.id, reason });
    await write({ ...base, time: now().toISOString(), invokedAgent: false, sessionId: null, resumed: false, postedType: "decline", postedText: text, redactions: [], discardReason: null, durationMs: 0, ...extra });
  };

  // This machine already posted for this message, yet the thread is pending again: the owner deleted the post.
  // Earlier messages whose posts were deleted are retracted too: never mark them unanswered again.
  // A reply covers every message up to its re target, so the latest covered message is a cutoff, not just one id.
  // covers lists them all, so the cutoff holds even if the sender deleted the re target itself.
  const postedRe = new Set(audit.filter((e) => e.threadId === t.id && e.postedType !== null).flatMap((e) => [e.re, ...(e.covers ?? [])]));
  const cutoff = Math.max(-1, ...p.unanswered.map((m, i) => (postedRe.has(m.id) ? i : -1)));
  const unanswered = p.unanswered.slice(cutoff + 1);
  const posted = audit.filter((e) => e.threadId === t.id && e.re === p.last.id && e.postedType !== null);
  if (posted.length || !unanswered.length) {
    if (!posted.some((e) => e.retraction)) {
      await postDecline(t, "refused", `@${deps.me} retracted the earlier automatic reply. If needed, contact @${deps.me} directly.`, { retraction: true });
      log(`Reply on #${t.number} was deleted by the owner; posted a retraction notice instead of answering again.`);
    } else if (!warnedRetracted.has(`${t.id}:${p.last.id}`)) {
      warnedRetracted.add(`${t.id}:${p.last.id}`);
      log(`The retraction notice on #${t.number} was deleted too; leaving the thread alone.`);
    }
    return;
  }

  if (threadRoundsUsed(t, deps.me) >= limits.rounds_per_thread) {
    await postDecline(t, "rate_limited", `This thread has reached the automatic-reply limit of ${limits.rounds_per_thread} rounds; @${deps.me} will handle it personally.`);
    return;
  }

  const lastForRe = audit.filter((e) => e.threadId === t.id && e.re === p.last.id).at(-1);
  if (lastForRe?.discardReason === "post_error" && now().getTime() - Date.parse(lastForRe.time) < POST_ERROR_BACKOFF_MS) {
    log(`Posting to #${t.number} failed recently; will retry later.`);
    return;
  }

  const resumeId = findResumableSession(audit, t.id, deps.backend.name);
  const discarded = lastAttemptDiscarded(audit, t.id);
  const draftedPublic = deps.publicThread ?? false;
  const ctx: PromptContext = {
    owner: deps.me, sender: t.author, threadUrl: t.url, threadNumber: t.number, publicThread: draftedPublic,
  };
  const plan: (string | null)[] = resumeId ? [resumeId, null, null] : [null, null];

  let outcome: Outcome = { ok: false, failure: "error" };
  let started = false;
  for (const sid of plan) {
    // Checked before every attempt: write() keeps `audit` current, so retries and sibling threads in a round share the budget.
    if (hourlyInvocations(audit, now()) >= limits.replies_per_hour) {
      log(started ? `Hourly invocation limit reached; leaving #${t.number} for later.` : `Hourly invocation limit of ${limits.replies_per_hour} reached; leaving #${t.number} for later.`);
      return;
    }
    started = true;
    const prompt = sid ? buildContinuationPrompt(ctx, unanswered, discarded) : buildInitialPrompt(ctx, t, unanswered);
    const r = await run({
      argv: deps.backend.argv({ resumeSessionId: sid }),
      stdin: prompt,
      cwd: deps.cwd,
      timeoutMs: limits.timeout_minutes * 60_000,
    });
    const entry: AuditEntry = {
      ...base, time: now().toISOString(), invokedAgent: true, sessionId: null, resumed: sid !== null, prompt,
      rawOutput: r.stdout, stderr: r.stderr.slice(-4000), postedType: null, postedText: null, redactions: [], discardReason: null,
      durationMs: r.durationMs,
    };
    if (r.timedOut) {
      await write({ ...entry, error: "timeout" });
      outcome = { ok: false, failure: "timeout" };
      break;
    }
    try {
      const br = deps.backend.parse(r);
      const decision = decide(parseAgentOutput(br.text));
      const sessionId = br.sessionId ?? sid;
      outcome = { ok: true, decision, sessionId, entry: { ...entry, sessionId } };
      break;
    } catch (e) {
      await write({ ...entry, error: errMsg(e) });
      log(`Responder agent failed on #${t.number}${sid ? " (resumed session)" : ""}: ${errMsg(e)}`);
    }
  }

  // Held Draft: re-fetch the thread before publishing
  // Also re-check visibility right before posting: the repo may have been made public while the agent ran.
  let fresh: Thread;
  let nowPrivate: boolean;
  try {
    fresh = await deps.transport.getThread(t.number);
    nowPrivate = await deps.transport.isPrivate(true);
  } catch (e) {
    if (outcome.ok) await write({ ...outcome.entry, postedType: null, discardReason: "post_error", error: `refetch failed: ${errMsg(e)}` });
    throw e;
  }
  if (!nowPrivate && !deps.repo.public) {
    if (outcome.ok) await write({ ...outcome.entry, postedType: null, discardReason: "repo_public" });
    throw new PublicRepoError(`The transport repo is no longer private; draft for #${t.number} discarded.`);
  }
  if (!nowPrivate && !draftedPublic) {
    deps.publicThread = true;
    if (outcome.ok) await write({ ...outcome.entry, postedType: null, discardReason: "repo_public" });
    log(`The transport repo is now public; draft for #${t.number} discarded and will be redone under the PUBLIC rule.`);
    return;
  }
  const p2 = pendingFor(fresh, deps.me);
  const stillSame = p2 !== null && p2.last.id === p.last.id;

  if (!outcome.ok) {
    if (!stillSame) return;
    const text =
      outcome.failure === "timeout"
        ? `Could not reply within ${limits.timeout_minutes} minutes; @${deps.me} needs to handle this personally.`
        : `The responder agent failed; @${deps.me} needs to handle this personally.`;
    await postDecline(fresh, outcome.failure, text);
    return;
  }

  const { decision, entry } = outcome;
  const bodyR = redact(decision.body);
  const footR = redact(footer(decision, deps.me, deps.backend.name));
  let body = bodyR.text;
  const room = MAX_POST - footR.text.length - TRUNCATED_NOTE.length;
  if (body.length > room) body = body.slice(0, Math.max(0, room)) + TRUNCATED_NOTE;
  const hits = [...bodyR.hits, ...footR.hits.map((h) => ({ ...h, index: h.index + body.length }))];
  const text = body + footR.text;
  if (!stillSame) {
    await write({ ...entry, redactions: hits, discardReason: p2 ? "new_followup" : "no_longer_pending" });
    log(`#${t.number} changed while the reply was being drafted; draft discarded.`);
    return;
  }
  try {
    await deps.transport.reply(fresh, text, {
      type: decision.type,
      re: p.last.id,
      ...(decision.type === "decline" ? { reason: decision.reason } : {}),
    });
  } catch (e) {
    await write({ ...entry, redactions: hits, discardReason: "post_error", error: `post failed: ${errMsg(e)}` });
    throw e;
  }
  await write({ ...entry, postedType: decision.type, postedText: text, redactions: hits });
  log(`Replied to #${t.number} (${decision.type}).`);
}

export async function serve(deps: RespondDeps, intervalMs = 60_000): Promise<never> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`[huddle] ${m}\n`));
  log(`Polling started (every ${intervalMs / 1000} s); press Ctrl-C to exit.`);
  for (;;) {
    let ok = true;
    try {
      await deps.beforeRound?.();
    } catch (e) {
      if (e instanceof PublicRepoError) throw e;
      ok = false;
      log(`Visibility check failed, skipping this round: ${errMsg(e)}`);
    }
    if (ok) {
      try {
        await respondOnce(deps);
      } catch (e) {
        if (e instanceof PublicRepoError) throw e;
        log(`This round failed; continuing with the next: ${errMsg(e)}`);
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
