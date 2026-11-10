import { askMeta, lastAskerMessage, responderMessages, sameLogin, unansweredAskerMessages } from "./conversation.js";
import { selfAskAllowed } from "./paths.js";
import type { Message, Thread } from "./types.js";

export interface Pending {
  last: Message;          // the asker's latest ask/followup; the reply's re takes its id
  unanswered: Message[];  // all unanswered asker messages this round must cover
}

/** Conditions 1-3 for a thread to need an answer. Admission checks and pausing are handled by the caller. */
export function pendingFor(t: Thread, me: string, allowSelf = selfAskAllowed()): Pending | null {
  if (t.category !== "ask" || t.closed || t.answerId !== null) return null;
  const am = askMeta(t);
  if (!am || !sameLogin(am.to, me) || (!allowSelf && sameLogin(t.author, me))) return null;
  const last = lastAskerMessage(t);
  if (!last) return null;
  if (responderMessages(t, me).some((m) => m.meta!.re === last.id)) return null;
  return { last, unanswered: unansweredAskerMessages(t, me) };
}

export const threadRoundsUsed = (t: Thread, me: string): number => responderMessages(t, me).length;
