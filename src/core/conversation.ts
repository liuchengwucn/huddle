import type { Message, Meta, ResponderType, Thread } from "./types.js";

const RESPONDER_TYPES: ReadonlySet<string> = new Set<ResponderType>(["answer", "clarify", "decline"]);

export const sameLogin = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The ask metadata of the opening message; null if the thread is not a huddle question. */
export function askMeta(t: Thread): Meta | null {
  const first = t.messages[0];
  return first && sameLogin(first.author, t.author) && first.meta?.type === "ask" ? first.meta : null;
}

export const responderOf = (t: Thread): string | null => askMeta(t)?.to ?? null;

export function askerMessages(t: Thread): Message[] {
  if (!askMeta(t)) return [];
  return t.messages.filter(
    (m) => sameLogin(m.author, t.author) && (m.meta?.type === "ask" || m.meta?.type === "followup"),
  );
}

export function responderMessages(t: Thread, responder: string): Message[] {
  return t.messages.filter(
    (m) => sameLogin(m.author, responder) && m.meta !== null && RESPONDER_TYPES.has(m.meta.type) && typeof m.meta.re === "string",
  );
}

export const lastAskerMessage = (t: Thread): Message | null => askerMessages(t).at(-1) ?? null;

export function replyTo(t: Thread, askerMessageId: string): Message | null {
  const r = responderOf(t);
  if (!r) return null;
  return responderMessages(t, r).filter((m) => m.meta!.re === askerMessageId).at(-1) ?? null;
}

/** All asker messages after the latest asker message the responder has replied to. Uses the largest index among all re targets, so out-of-order replies cannot re-queue answered messages. */
export function unansweredAskerMessages(t: Thread, responder: string): Message[] {
  const asks = askerMessages(t);
  const replies = responderMessages(t, responder);
  const last = replies.at(-1);
  if (!last) return asks;
  const idx = Math.max(...replies.map((r) => asks.findIndex((m) => m.id === r.meta!.re)));
  if (idx >= 0) return asks.slice(idx + 1);
  // All re targets were deleted: fall back to timestamps
  return asks.filter((m) => m.createdAt > last.createdAt);
}

/** Comments without metadata (plain human comments) after a given message. */
export function humanCommentsAfter(t: Thread, after: Message): Message[] {
  const i = t.messages.findIndex((m) => m.id === after.id);
  return t.messages.slice(i + 1).filter((m) => m.meta === null);
}

export type ReplyStatus = ResponderType | "pending";

/** Reply state for the asker's latest message. Returns null if the thread is not a huddle question. */
export function classifyReply(t: Thread): { status: ReplyStatus; reply: Message | null; awaiting: Message } | null {
  const awaiting = lastAskerMessage(t);
  if (!awaiting) return null;
  const reply = replyTo(t, awaiting.id);
  if (!reply) return { status: "pending", reply: null, awaiting };
  return { status: reply.meta!.type as ResponderType, reply, awaiting };
}
