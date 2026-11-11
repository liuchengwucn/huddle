import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { signature, stripSignature } from "../core/signature.js";
import type { Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import { messageMeta, sameLogin } from "../core/conversation.js";
import { parseThreadRef } from "../transport/refs.js";
import { assertNotResponder, type Ctx } from "./context.js";

const out = (s: string) => process.stdout.write(`${s}\n`);

async function readBody(src: string): Promise<string> {
  if (src === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(src, "utf8");
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function getEntry(c: Ctx, ref: string): Promise<Thread> {
  const t = await c.transport.getThread(parseThreadRef(ref, c.slug));
  if (t.category !== "kb" || t.messages[0]?.meta?.type !== "kb") throw new HuddleError(`#${t.number} is not a huddle knowledge base entry.`);
  return t;
}

export async function publish(c: Ctx, src: string, o: { title: string; edit?: string; yes?: boolean }): Promise<number> {
  assertNotResponder();
  const entry = o.edit !== undefined ? await getEntry(c, o.edit) : null;
  if (entry && !entry.viewerCanUpdate) throw new HuddleError(`You do not have permission to edit knowledge base entry #${entry.number} (author or repo maintainer required).`);
  const body = stripSignature(await readBody(src));
  if (!body.trim()) throw new HuddleError("Entry body must not be empty");
  if (!o.yes && src !== "-" && process.stdin.isTTY) {
    process.stderr.write(`\n# ${o.title}\n\n${body}\n\n`);
    if (!(await confirm(entry ? `Replace knowledge base entry #${entry.number} with this?` : "Publish this to the knowledge base?"))) {
      out("Cancelled.");
      return 1;
    }
  }
  if (entry) {
    await c.transport.updateThread(entry, o.title, body + signature(`Updated by ${c.me}`), { type: "kb" });
    out(`Updated knowledge base entry #${entry.number}: ${entry.url}`);
    return 0;
  }
  const t = await c.transport.createThread("kb", o.title, body + signature(`Published by ${c.me}`), { type: "kb" });
  out(`Published to the knowledge base: #${t.number} ${t.url}`);
  return 0;
}

export function snippet(text: string, max = 200): string {
  const s = stripSignature(text).replace(/\s+/g, " ").trim();
  return [...s].length > max ? `${[...s].slice(0, max).join("")}…` : s;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function search(c: Ctx, query: string): Promise<number> {
  const results = await c.transport.search(query, ["kb", "messages"], false);
  const writeCache = new Map<string, Promise<boolean>>();
  const writer = (login: string | undefined): Promise<boolean> => {
    if (!login) return Promise.resolve(false);
    const k = login.toLowerCase();
    let p = writeCache.get(k);
    if (!p) {
      p = c.transport.hasWriteAccess(login).catch(() => false);
      writeCache.set(k, p);
    }
    return p;
  };
  const entries: Thread[] = [];
  const threads: Thread[] = [];
  for (const t of results) {
    if (t.category === "kb" && t.messages[0]?.meta?.type === "kb") {
      if (await writer(t.author)) entries.push(t);
    } else if (t.category === "messages") {
      const to = messageMeta(t)?.to;
      if (to && (await writer(t.author)) && (await writer(to))) threads.push(t);
    }
  }
  const other = results.filter((t) => !entries.includes(t) && !threads.includes(t));
  const ordered = [...entries, ...threads, ...other].slice(0, 8);
  if (!ordered.length) {
    out("No related knowledge base entries or past threads found.");
    return 0;
  }
  for (const t of ordered) {
    if (entries.includes(t)) {
      out(`[KB #${t.number}] (updated ${day(t.editedAt)}) ${t.title}\n  ${t.url}\n  ${snippet(t.messages[0].body)}`);
    } else if (threads.includes(t)) {
      const to = messageMeta(t)?.to;
      const reply = t.messages.filter((m) => m.meta?.type === "reply" && sameLogin(m.author, to)).at(-1);
      out(`[Thread #${t.number}] ${t.title}\n  ${t.url}\n  ${snippet(reply ? reply.body : t.messages[0].body)}`);
    } else {
      out(`[Discussion #${t.number}] ${t.title}\n  ${t.url}\n  ${snippet(t.messages[0].body)}`);
    }
  }
  return 0;
}
