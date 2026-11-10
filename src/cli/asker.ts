import { execFileSync } from "node:child_process";
import { askMeta, classifyReply, humanCommentsAfter, lastAskerMessage, responderMessages, responderOf, sameLogin } from "../core/conversation.js";
import { pendingFor } from "../core/pending.js";
import { resolveRecipient } from "../core/recipient.js";
import type { Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import { parseThreadRef } from "../transport/refs.js";
import { assertNotResponder, type Ctx } from "./context.js";
import { waitForReply, type WaitResult } from "./wait.js";

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
const note = (s: string) => process.stderr.write(`[huddle] ${s}\n`);
const publicNote = (c: Ctx) => {
  if (c.publicThreads) process.stderr.write(`huddle: note: ${c.slug} is public; this thread is visible to everyone. Do not include private information.\n`);
};
const emit = (r: WaitResult): number => {
  out(r.output);
  return r.code;
};

function gitAuthorNames(root: string, email: string): string[] {
  try {
    const outp = execFileSync("git", ["log", "--format=%an", "--fixed-strings", "-i", "-n", "200", `--author=${email}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(outp.split("\n").map((s) => s.trim()).filter(Boolean))].slice(0, 5);
  } catch {
    return [];
  }
}

export function makeTitle(question: string): string {
  const line = question.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "huddle question";
  const chars = [...line.replace(/\s+/g, " ")];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : chars.join("");
}

export function isShortQuestion(question: string): boolean {
  const sentences = question.split(/[\u3002\uff01\uff1f!?.\n]+/).filter((s) => s.trim()).length;
  return sentences < 3 || [...question.trim()].length < 100;
}

export async function ask(c: Ctx, question: string, o: { to: string; files: string[]; wait: number }): Promise<number> {
  assertNotResponder();
  if (!question.trim()) throw new HuddleError("Question must not be empty");
  const to = await resolveRecipient(c.transport, o.to, c.me, (e) => gitAuthorNames(c.root, e));
  if (isShortQuestion(question)) note("The question is short. A good question includes: the goal, what you already tried, related files, and the exact error. (Sending anyway.)");
  const fileLine = o.files.length ? `\n\nRelated files: ${o.files.map((f) => `\`${f}\``).join(", ")}` : "";
  publicNote(c);
  const t = await c.transport.createThread("ask", makeTitle(question), question + fileLine, {
    type: "ask",
    to,
    ...(o.files.length ? { files: o.files } : {}),
  });
  note(`Asked ${to}: #${t.number} ${t.url}`);
  return emit(await waitForReply(c.transport, t.number, o.wait));
}

export async function waitCmd(c: Ctx, ref: string, o: { wait: number }): Promise<number> {
  return emit(await waitForReply(c.transport, parseThreadRef(ref, c.slug), o.wait));
}

async function ownAskThread(c: Ctx, ref: string): Promise<Thread> {
  const t = await c.transport.getThread(parseThreadRef(ref, c.slug));
  if (!askMeta(t)) throw new HuddleError(`Thread #${t.number} is not a huddle question.`);
  if (!sameLogin(t.author, c.me)) throw new HuddleError(`Only the asker ${t.author} can act on thread #${t.number}.`);
  return t;
}

export async function reply(c: Ctx, ref: string, text: string, o: { wait: number }): Promise<number> {
  assertNotResponder();
  if (!text.trim()) throw new HuddleError("Follow-up text must not be empty");
  const t = await ownAskThread(c, ref);
  if (t.closed) throw new HuddleError(`Thread #${t.number} is closed; use huddle ask to open a new thread.`);
  publicNote(c);
  let unmarked = false;
  if (t.answerId) {
    await c.transport.unmarkResolved(t);
    unmarked = true;
    note(`Thread #${t.number} had an answer marked; unmarked it automatically so the follow-up can continue.`);
  }
  try {
    await c.transport.reply(t, text, { type: "followup" });
  } catch (e) {
    if (unmarked) {
      throw new HuddleError(`Sending the follow-up failed, and the earlier answer mark on thread #${t.number} was removed: ${(e as Error).message}. Re-run huddle reply, or re-mark with huddle resolve ${t.number}.`);
    }
    throw e;
  }
  return emit(await waitForReply(c.transport, t.number, o.wait));
}

export async function resolve(c: Ctx, ref: string): Promise<number> {
  assertNotResponder();
  const t = await ownAskThread(c, ref);
  const answer = responderMessages(t, responderOf(t)!).filter((m) => m.meta!.type === "answer").at(-1);
  if (!answer) throw new HuddleError(`Thread #${t.number} has no answer yet, so nothing can be marked.`);
  await c.transport.markResolved(t, answer.id);
  out(`Marked the latest answer on thread #${t.number} as the accepted answer.`);
  return 0;
}

function statusLabel(t: Thread): string {
  if (t.closed) return "closed";
  if (t.answerId) return "resolved";
  const s = classifyReply(t);
  if (!s) return "unknown";
  switch (s.status) {
    case "pending": return "waiting";
    case "answer": return "answered";
    case "clarify": return "clarification requested";
    default: return `cannot answer (${s.reply!.meta!.reason})`;
  }
}

function hasHuman(t: Thread): boolean {
  const last = lastAskerMessage(t);
  return !!last && humanCommentsAfter(t, last).length > 0;
}

export async function inbox(c: Ctx): Promise<number> {
  const threads = await c.transport.listUpdatedThreads("ask", new Date(Date.now() - 7 * 86400_000));
  const mine = threads.filter((t) => sameLogin(t.author, c.me) && askMeta(t));
  const toMe = threads.filter((t) => pendingFor(t, c.me));
  out("Questions I asked (last 7 days):");
  if (!mine.length) out("  (none)");
  for (const t of mine) out(`  #${t.number} [${statusLabel(t)}${hasHuman(t) ? " +human reply" : ""}] → ${responderOf(t)}  ${t.title}  ${t.url}`);
  out("\nAddressed to me, awaiting an answer:");
  if (!toMe.length) out("  (none)");
  for (const t of toMe) out(`  #${t.number} from ${t.author}  ${t.title}  ${t.url}`);
  return 0;
}
