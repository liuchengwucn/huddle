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

async function getCard(c: Ctx, ref: string): Promise<Thread> {
  const t = await c.transport.getThread(parseThreadRef(ref, c.slug));
  if (t.category !== "cards" || t.messages[0]?.meta?.type !== "card") throw new HuddleError(`#${t.number} is not a huddle knowledge card.`);
  return t;
}

export async function publish(c: Ctx, src: string, o: { title: string; edit?: string; yes?: boolean }): Promise<number> {
  assertNotResponder();
  const card = o.edit !== undefined ? await getCard(c, o.edit) : null;
  if (card && !card.viewerCanUpdate) throw new HuddleError(`You do not have permission to edit card #${card.number} (author or repo maintainer required).`);
  const body = stripSignature(await readBody(src));
  if (!body.trim()) throw new HuddleError("Card body must not be empty");
  if (!o.yes && src !== "-" && process.stdin.isTTY) {
    process.stderr.write(`\n# ${o.title}\n\n${body}\n\n`);
    if (!(await confirm(card ? `Replace card #${card.number} with this?` : "Publish this card?"))) {
      out("Cancelled.");
      return 1;
    }
  }
  if (card) {
    await c.transport.updateThread(card, o.title, body + signature(`Updated by ${c.me}`), { type: "card" });
    out(`Updated card #${card.number}: ${card.url}`);
    return 0;
  }
  const t = await c.transport.createThread("cards", o.title, body + signature(`Published by ${c.me}`), { type: "card" });
  out(`Published card #${t.number}: ${t.url}`);
  return 0;
}

export function snippet(text: string, max = 200): string {
  const s = stripSignature(text).replace(/\s+/g, " ").trim();
  return [...s].length > max ? `${[...s].slice(0, max).join("")}…` : s;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function search(c: Ctx, query: string): Promise<number> {
  const results = await c.transport.search(query, ["cards", "messages"], false);
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
  const cards: Thread[] = [];
  const threads: Thread[] = [];
  for (const t of results) {
    if (t.category === "cards" && t.messages[0]?.meta?.type === "card") {
      if (await writer(t.author)) cards.push(t);
    } else if (t.category === "messages") {
      const to = messageMeta(t)?.to;
      if (to && (await writer(t.author)) && (await writer(to))) threads.push(t);
    }
  }
  const other = results.filter((t) => !cards.includes(t) && !threads.includes(t));
  const ordered = [...cards, ...threads, ...other].slice(0, 8);
  if (!ordered.length) {
    out("No related cards or past threads found.");
    return 0;
  }
  for (const t of ordered) {
    if (cards.includes(t)) {
      out(`[Card #${t.number}] (updated ${day(t.editedAt)}) ${t.title}\n  ${t.url}\n  ${snippet(t.messages[0].body)}`);
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
