import { classifyReply, humanCommentsAfter } from "../core/conversation.js";
import type { Message, Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import type { Transport } from "../transport/types.js";

export interface WaitResult {
  code: 0 | 2 | 3 | 4;
  output: string;
}

const DECLINE_HINT: Record<string, string> = {
  timeout: "You can retry later with huddle reply.",
  error: "You can retry later with huddle reply.",
  low_confidence: "They do not know the answer; consider asking someone else.",
  refused: "They declined to answer; tell the user why.",
  rate_limited: "This topic needs direct human communication; tell the user, and do not open a new thread to get around the limit.",
};

export function formatReply(t: Thread, reply: Message): WaitResult {
  const n = t.number;
  switch (reply.meta!.type) {
    case "answer":
      return {
        code: 0,
        output: `${reply.body}\n\n[huddle] Thread #${n} has an answer. Run huddle resolve ${n} once the question is settled; to follow up, use huddle reply ${n} "<text>".`,
      };
    case "clarify":
      return {
        code: 4,
        output: `[huddle] They need clarification (thread #${n}):\n\n${reply.body}\n\n[huddle] Add the missing information with huddle reply ${n} "<text>".`,
      };
    default: {
      const reason = reply.meta!.reason ?? "refused";
      return {
        code: 3,
        output: `[huddle] Their agent cannot answer (reason: ${reason}, thread #${n}):\n\n${reply.body}\n\n[huddle] ${DECLINE_HINT[reason] ?? "Tell the user why; rephrase the question or ask someone else if needed."}`,
      };
    }
  }
}

export function timeoutResult(t: Thread): WaitResult {
  return {
    code: 2,
    output: `[huddle] Timed out waiting; thread #${t.number} (${t.url}) has no reply yet. Work on things that do not depend on the answer, then check with huddle wait ${t.number} or huddle inbox.`,
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

/** Polls the thread until the asker's latest message gets a reply, or times out. */
export async function waitForReply(t: Transport, number: number, waitSec: number, o: WaitOptions = {}): Promise<WaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 15_000;
  const deadline = now() + waitSec * 1000;
  let failures = 0;
  for (;;) {
    let thread: Thread;
    try {
      thread = await t.getThread(number);
      failures = 0;
    } catch (e) {
      const left = deadline - now();
      if (++failures >= 3 || left <= 0) {
        throw new HuddleError(`Reading thread #${number} failed repeatedly: ${(e as Error).message}. Run huddle wait ${number} later to keep waiting.`);
      }
      await sleep(Math.min(pollMs, left));
      continue;
    }
    const c = classifyReply(thread);
    if (!c) throw new HuddleError(`Thread #${number} is not a huddle question.`);
    if (c.reply) {
      const r = formatReply(thread, c.reply);
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
