import { HuddleError } from "../errors.js";
import type { Category, Message, Meta, Thread, User } from "../core/types.js";
import type { Transport } from "./types.js";

/** In-memory implementation for tests. All return values are deep copies, so behavior stays close to a real platform. */
export class FakeTransport implements Transport {
  private threads = new Map<number, Thread>();
  private seq = 0;
  private threadSeq = 0;
  private clock: number;
  private = true;
  readonly writers = new Set<string>();
  readonly emails = new Map<string, string>();

  constructor(public current: string, startMs = Date.parse("2026-11-01T00:00:00Z")) {
    this.clock = startMs;
  }

  as(login: string): this {
    this.current = login;
    return this;
  }

  private tick(): Date {
    this.clock += 1000;
    return new Date(this.clock);
  }

  private get(n: number): Thread {
    const t = this.threads.get(n);
    if (!t) throw new HuddleError(`Thread #${n} not found`);
    return t;
  }

  async whoami(): Promise<User> {
    return { login: this.current };
  }

  async isPrivate(): Promise<boolean> {
    return this.private;
  }

  async checkSetup(): Promise<string[]> {
    return [];
  }

  async createThread(cat: Category, title: string, text: string, meta: Meta): Promise<Thread> {
    const number = ++this.threadSeq;
    const at = this.tick();
    const id = `D_${++this.seq}`;
    const url = `https://fake.test/discussions/${number}`;
    const t: Thread = {
      id, number, url, title, category: cat, author: this.current, closed: false, updatedAt: at,
      messages: [{ id, author: this.current, createdAt: at, body: text, meta: structuredClone(meta), url }],
      viewerCanUpdate: true,
    };
    this.threads.set(number, t);
    return structuredClone(t);
  }

  private push(thread: Thread, text: string, meta: Meta | null): Message {
    const t = this.get(thread.number);
    const at = this.tick();
    const id = `C_${++this.seq}`;
    const m: Message = { id, author: this.current, createdAt: at, body: text, meta: structuredClone(meta), url: `${t.url}#discussioncomment-${id}` };
    t.messages.push(m);
    t.updatedAt = at;
    return structuredClone(m);
  }

  async reply(thread: Thread, text: string, meta: Meta): Promise<Message> {
    return this.push(thread, text, meta);
  }

  /** Test only: post a human comment without metadata. */
  humanComment(thread: Thread, text: string): Message {
    return this.push(thread, text, null);
  }

  /** Test only: delete a comment (as done on the web). */
  deleteComment(messageId: string): void {
    for (const t of this.threads.values()) {
      const i = t.messages.findIndex((m, idx) => idx > 0 && m.id === messageId);
      if (i > 0) {
        t.messages.splice(i, 1);
        return;
      }
    }
    throw new HuddleError(`Comment ${messageId} not found`);
  }

  /** Test only: close a thread (as done on the web). */
  closeThread(thread: Thread): void {
    this.get(thread.number).closed = true;
  }

  async getThread(number: number): Promise<Thread> {
    return structuredClone(this.get(number));
  }

  async listUpdatedThreads(cat: Category, since: Date): Promise<Thread[]> {
    return [...this.threads.values()].filter((t) => t.category === cat && t.updatedAt >= since).map((t) => structuredClone(t));
  }

  async updateThread(thread: Thread, title: string, text: string, meta: Meta): Promise<void> {
    const t = this.get(thread.number);
    t.title = title;
    t.messages[0] = { ...t.messages[0], body: text, meta: structuredClone(meta) };
    t.updatedAt = this.tick();
  }

  async search(query: string, cats: Category[], includeClosed: boolean): Promise<Thread[]> {
    const q = query.toLowerCase();
    return [...this.threads.values()]
      .filter((t) => cats.includes(t.category) && (includeClosed || !t.closed))
      .filter((t) => t.title.toLowerCase().includes(q) || t.messages.some((m) => m.body.toLowerCase().includes(q)))
      .map((t) => structuredClone(t));
  }

  async hasWriteAccess(login: string): Promise<boolean> {
    return this.writers.has(login.toLowerCase());
  }

  async resolveLogin(email: string): Promise<string | null> {
    return this.emails.get(email.toLowerCase()) ?? null;
  }
}
