import { execFileSync } from "node:child_process";
import { classifyReply, messageMeta, sameLogin } from "../core/conversation.js";
import { signature } from "../core/signature.js";
import { resolveRecipient } from "../core/recipient.js";
import type { Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import { parseThreadRef } from "../transport/refs.js";
import { assertNotResponder, type Ctx } from "./context.js";
import { waitForReply, type WaitOptions, type WaitResult } from "./wait.js";

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

export function makeTitle(message: string): string {
  const line = message.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "huddle message";
  const chars = [...line.replace(/\s+/g, " ")];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : chars.join("");
}

const SEND_USAGE = 'Usage: huddle send --to <who> "<message>" to start a thread, or huddle send <thread> "<message>" to follow up.';

/** With --to: exactly one positional (the message, new thread). Without: <thread> <message> (follow-up). */
export function parseSendArgs(first: string, second: string | undefined, to: string | undefined): { ref?: string; message: string } {
  if (to !== undefined) {
    if (second !== undefined) throw new HuddleError(`--to starts a new thread and takes only the message. ${SEND_USAGE}`);
    return { message: first };
  }
  if (second === undefined) throw new HuddleError(`Without --to, pass both <thread> and <message>. ${SEND_USAGE}`);
  return { ref: first, message: second };
}

export async function send(c: Ctx, message: string, o: { to: string; wait?: number }, w?: WaitOptions): Promise<number> {
  assertNotResponder();
  if (!message.trim()) throw new HuddleError("Message must not be empty");
  const to = await resolveRecipient(c.transport, o.to, c.me, (e) => gitAuthorNames(c.root, e));
  publicNote(c);
  const t = await c.transport.createThread("messages", makeTitle(message), message + signature(`Sent by ${c.me}'s agent`), { type: "message", to });
  note(`Sent to ${to}: #${t.number} ${t.url}`);
  return emit(await waitForReply(c.transport, t.number, o.wait, w));
}

export async function followUp(c: Ctx, ref: string, message: string, o: { wait?: number }, w?: WaitOptions): Promise<number> {
  assertNotResponder();
  if (!message.trim()) throw new HuddleError("Message must not be empty");
  const t = await c.transport.getThread(parseThreadRef(ref, c.slug));
  if (!messageMeta(t)) throw new HuddleError(`Thread #${t.number} is not a huddle message thread.`);
  if (!sameLogin(t.author, c.me)) throw new HuddleError(`Only the sender ${t.author} can follow up on thread #${t.number}.`);
  if (t.closed) throw new HuddleError(`Thread #${t.number} is closed; use huddle send --to to open a new thread.`);
  publicNote(c);
  await c.transport.reply(t, message + signature(`Sent by ${c.me}'s agent`), { type: "message" });
  return emit(await waitForReply(c.transport, t.number, o.wait, w));
}

/**
 * Among threads I started (updated in the last 7 days), the one where I sent a message most recently.
 * It may already have a reply or be closed: an interrupted send must still get its outcome, which waitForReply returns at once.
 */
async function latestSent(c: Ctx): Promise<Thread> {
  const threads = await c.transport.listUpdatedThreads("messages", new Date(Date.now() - 7 * 86400_000));
  let best: { t: Thread; at: number } | null = null;
  for (const t of threads) {
    if (!sameLogin(t.author, c.me)) continue;
    const s = classifyReply(t);
    if (!s) continue;
    const at = s.awaiting.createdAt.getTime();
    if (!best || at > best.at) best = { t, at };
  }
  const t = best?.t;
  if (!t) throw new HuddleError("You have sent no message in the last 7 days. Pass a thread number.");
  return t;
}

export async function waitCmd(c: Ctx, ref: string | undefined, o: { wait?: number }, w?: WaitOptions): Promise<number> {
  let n: number;
  if (ref !== undefined) n = parseThreadRef(ref, c.slug);
  else {
    const t = await latestSent(c);
    note(`Waiting on #${t.number} ${t.url}`);
    n = t.number;
  }
  return emit(await waitForReply(c.transport, n, o.wait, w));
}
