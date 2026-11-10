import type { Category, Message, Meta, Thread, User } from "../core/types.js";

export interface Transport {
  whoami(): Promise<User>;
  /** Whether the transport repo is private; `fresh` bypasses any cache. */
  isPrivate(fresh?: boolean): Promise<boolean>;
  /** Returns a list of human-readable configuration problems; an empty array means all is well. */
  checkSetup(): Promise<string[]>;
  createThread(cat: Category, title: string, text: string, meta: Meta): Promise<Thread>;
  reply(thread: Thread, text: string, meta: Meta): Promise<Message>;
  deleteMessage(messageId: string): Promise<void>;
  getThread(number: number): Promise<Thread>;
  /** ref is a comment URL or comment id. */
  locateMessage(ref: string): Promise<{ thread: Thread; message: Message }>;
  listUpdatedThreads(cat: Category, since: Date): Promise<Thread[]>;
  markResolved(thread: Thread, messageId: string): Promise<void>;
  unmarkResolved(thread: Thread): Promise<void>;
  close(thread: Thread, reason: "resolved" | "outdated" | "duplicate"): Promise<void>;
  updateThread(thread: Thread, title: string, text: string, meta: Meta): Promise<void>;
  deleteThread(thread: Thread): Promise<void>;
  search(query: string, cats: Category[], includeClosed: boolean): Promise<Thread[]>;
  /** On 403 (the caller itself may not query this) throw HuddleError instead of returning false. */
  hasWriteAccess(login: string): Promise<boolean>;
  resolveLogin(email: string): Promise<string | null>;
}
