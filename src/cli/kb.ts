import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Meta, Thread } from "../core/types.js";
import { HuddleError } from "../errors.js";
import { askMeta, sameLogin } from "../core/conversation.js";
import { staleness, STALENESS_LABEL } from "../kb/stale.js";
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
  if (t.category !== "kb" || t.messages[0]?.meta?.type !== "kb") throw new HuddleError(`#${t.number} is not a huddle knowledge card.`);
  return t;
}

export async function publish(
  c: Ctx,
  src: string,
  o: { title: string; files: string[]; source?: string; supersedes?: string; yes?: boolean },
): Promise<number> {
  assertNotResponder();
  const body = await readBody(src);
  if (!body.trim()) throw new HuddleError("Card body must not be empty");
  const old = o.supersedes ? await getCard(c, o.supersedes) : null;
  if (old && !old.viewerCanUpdate) throw new HuddleError(`You do not have permission to edit card #${old.number}, so you cannot supersede it.`);
  const source = o.source ? (await c.transport.getThread(parseThreadRef(o.source, c.slug))).url : undefined;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: c.root, encoding: "utf8" }).trim();
  const meta: Meta = {
    type: "kb",
    ...(o.files.length ? { files: o.files } : {}),
    commit,
    ...(source ? { source } : {}),
    ...(old ? { supersedes: String(old.number) } : {}),
  };
  if (!o.yes && src !== "-" && process.stdin.isTTY) {
    process.stderr.write(`\n# ${o.title}\n\n${body}\n\n`);
    if (!(await confirm("Publish this card?"))) {
      out("Cancelled.");
      return 1;
    }
  }
  const card = await c.transport.createThread("kb", o.title, body, meta);
  if (old) {
    await c.transport.updateThread(old, old.title, `${old.messages[0].body}\n\n> Superseded by #${card.number}: ${card.url}`, old.messages[0].meta ?? { type: "kb" });
    await c.transport.close(old, "outdated");
  }
  out(`Published card #${card.number}: ${card.url}`);
  return 0;
}

export async function kbEdit(c: Ctx, ref: string, src: string): Promise<number> {
  assertNotResponder();
  const card = await getCard(c, ref);
  if (!card.viewerCanUpdate) throw new HuddleError(`You do not have permission to edit card #${card.number} (author or repo maintainer required).`);
  const body = await readBody(src);
  if (!body.trim()) throw new HuddleError("Card body must not be empty");
  await c.transport.updateThread(card, card.title, body, card.messages[0].meta ?? { type: "kb" });
  out(`Revised card #${card.number}: ${card.url}`);
  return 0;
}

export async function kbRm(c: Ctx, ref: string, o: { yes?: boolean }): Promise<number> {
  assertNotResponder();
  const card = await getCard(c, ref);
  if (!card.viewerCanDelete) throw new HuddleError(`You do not have permission to delete card #${card.number} (author or repo maintainer required).`);
  if (!o.yes && process.stdin.isTTY && !(await confirm(`Delete card #${card.number} "${card.title}"?`))) {
    out("Cancelled.");
    return 1;
  }
  await c.transport.deleteThread(card);
  out(`Deleted card #${card.number}.`);
  return 0;
}

export function snippet(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return [...s].length > max ? `${[...s].slice(0, max).join("")}…` : s;
}

export async function search(c: Ctx, query: string): Promise<number> {
  const results = await c.transport.search(query, ["kb", "ask"], false);
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
  const qa: Thread[] = [];
  for (const t of results) {
    if (t.category === "kb" && t.messages[0]?.meta?.type === "kb") {
      if (await writer(t.author)) cards.push(t);
    } else if (t.category === "ask") {
      const to = askMeta(t)?.to;
      if (to && (await writer(t.author)) && (await writer(to))) qa.push(t);
    }
  }
  const other = results.filter((t) => !cards.includes(t) && !qa.includes(t));
  const ordered = [...cards, ...qa, ...other].slice(0, 8);
  if (!ordered.length) {
    out("No related knowledge cards or past Q&A found.");
    return 0;
  }
  for (const t of ordered) {
    if (cards.includes(t)) {
      const s = staleness(t.messages[0].meta, c.root, c.repo.kb.stale_lines);
      out(`[KB #${t.number}] [${STALENESS_LABEL[s]}] ${t.title}\n  ${t.url}\n  ${snippet(t.messages[0].body)}`);
    } else if (qa.includes(t)) {
      const to = askMeta(t)?.to;
      const byTo = (m: Thread["messages"][number]) => sameLogin(m.author, to);
      const ans = t.messages.find((m) => m.id === t.answerId && byTo(m)) ?? t.messages.filter((m) => m.meta?.type === "answer" && byTo(m)).at(-1);
      out(`[Q&A #${t.number}] ${t.title}\n  ${t.url}\n  ${snippet(ans ? ans.body : t.messages[0].body)}`);
    } else {
      out(`[Discussion #${t.number}] ${t.title}\n  ${t.url}\n  ${snippet(t.messages[0].body)}`);
    }
  }
  return 0;
}
