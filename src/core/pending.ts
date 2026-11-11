import { lastSenderMessage, messageMeta, responderMessages, sameLogin, unansweredSenderMessages } from "./conversation.js";
import { selfSendAllowed } from "./paths.js";
import type { Message, Thread } from "./types.js";

export interface Pending {
  last: Message;          // the sender's latest message; the reply's re takes its id
  unanswered: Message[];  // all unanswered sender messages this round must cover
}

/** Conditions for a thread to need a reply. Admission checks are handled by the caller. */
export function pendingFor(t: Thread, me: string, allowSelf = selfSendAllowed()): Pending | null {
  if (t.category !== "messages" || t.closed) return null;
  const mm = messageMeta(t);
  if (!mm || !sameLogin(mm.to, me) || (!allowSelf && sameLogin(t.author, me))) return null;
  const last = lastSenderMessage(t);
  if (!last) return null;
  if (responderMessages(t, me).some((m) => m.meta!.re === last.id)) return null;
  // Empty when a visible reply covers `last` but targets a later message the sender has since deleted.
  const unanswered = unansweredSenderMessages(t, me);
  return unanswered.length ? { last, unanswered } : null;
}

export const threadRoundsUsed = (t: Thread, me: string): number => responderMessages(t, me).length;
