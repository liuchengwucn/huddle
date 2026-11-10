import { classifyReply, humanCommentsAfter } from "../core/conversation.js";
import type { Message, Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import type { Transport } from "../transport/types.js";

export interface WaitResult {
  code: 0 | 2 | 3;
  output: string;
}

const declineHint = (reason: string, n: number): string =>
  ({
    timeout: `You can retry later with huddle send ${n} "<text>".`,
    error: `You can retry later with huddle send ${n} "<text>".`,
    low_confidence: "They do not know enough to reply; consider sending to someone else.",
    refused: "They declined to reply; tell the user why.",
    rate_limited: "This topic needs direct human communication; tell the user, and do not open a new thread to get around the limit.",
  })[reason] ?? "Tell the user why; rephrase or send to someone else if needed.";

export function formatReply(t: Thread, reply: Message): WaitResult {
  const n = t.number;
  if (reply.meta!.type === "reply") {
    return { code: 0, output: `${reply.body}\n\n[huddle] Thread #${n} has a reply. To follow up: huddle send ${n} "<text>".` };
  }
  const reason = reply.meta!.reason ?? "refused";
  return {
    code: 3,
    output: `[huddle] Their agent cannot reply (reason: ${reason}, thread #${n}):\n\n${reply.body}\n\n[huddle] ${declineHint(reason, n)}`,
  };
}

export function timeoutResult(t: Thread): WaitResult {
  return {
    code: 2,
    output: `[huddle] Timed out waiting; thread #${t.number} (${t.url}) has no reply yet. Work on things that do not depend on the reply, then check later with huddle wait ${t.number}.`,
  };
}

export function closedResult(t: Thread): WaitResult {
  return {
    code: 3,
    output: `[huddle] Thread #${t.number} was closed without a reply; the owner ended the conversation. Tell the user, or contact them directly.`,
  };
}

/** Note about human replies (comments without metadata); empty string if there are none. */
export async function humanNote(t: Thread, after: Message, transport: Pick<Transport, "hasWriteAccess">): Promise<string> {
  const hs: Message[] = [];
  const cache = new Map<string, boolean>();
  for (const m of humanCommentsAfter(t, after)) {
    const k = m.author.toLowerCase();
    if (!cache.has(k)) cache.set(k, await transport.hasWriteAccess(m.author).catch(() => false));
    if (cache.get(k)) hs.push(m);
  }
  if (!hs.length) return "";
  const lines = hs.map((m) => `- ${m.author} (${m.createdAt.toISOString()}): ${m.body.trim().slice(0, 300)}`);
  return `\n\n[huddle] The thread also has human replies:\n${lines.join("\n")}`;
}

export interface WaitOptions {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Polls the thread until the sender's latest message gets a reply, the thread is closed, or the wait times out; `waitSec` undefined waits indefinitely (and tolerates more read failures). */
export async function waitForReply(t: Transport, number: number, waitSec: number | undefined, o: WaitOptions = {}): Promise<WaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 15_000;
  const deadline = waitSec === undefined ? Infinity : now() + waitSec * 1000;
  const maxFailures = waitSec === undefined ? 20 : 3;
  let failures = 0;
  for (;;) {
    let thread: Thread;
    try {
      thread = await t.getThread(number);
      failures = 0;
    } catch (e) {
      const left = deadline - now();
      if (++failures >= maxFailures || left <= 0) {
        throw new HuddleError(`Reading thread #${number} failed repeatedly: ${(e as Error).message}. Run huddle wait ${number} later to keep waiting.`);
      }
      await sleep(Math.min(pollMs, left));
      continue;
    }
    const c = classifyReply(thread);
    if (!c) throw new HuddleError(`Thread #${number} is not a huddle message thread.`);
    if (c.reply) {
      const r = formatReply(thread, c.reply);
      return { ...r, output: r.output + (await humanNote(thread, c.awaiting, t)) };
    }
    if (thread.closed) {
      const r = closedResult(thread);
      return { ...r, output: r.output + (await humanNote(thread, c.awaiting, t)) };
    }
    const left = deadline - now();
    if (left <= 0) {
      const r = timeoutResult(thread);
      return { ...r, output: r.output + (await humanNote(thread, c.awaiting, t)) };
    }
    await sleep(Math.min(pollMs, left));
  }
}
