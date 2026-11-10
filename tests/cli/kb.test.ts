import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kbEdit, kbRm, publish, search, snippet } from "../../src/cli/kb.js";
import type { Ctx } from "../../src/cli/context.js";
import { DEFAULT_REPO_CONFIG, parseMachineConfig } from "../../src/config.js";
import type { Thread } from "../../src/core/types.js";
import { FakeTransport } from "../../src/transport/fake.js";

/** Test helper: can force viewerCanUpdate / viewerCanDelete to false. */
class RestrictedTransport extends FakeTransport {
  canUpdate = true;
  canDelete = true;
  override async getThread(n: number): Promise<Thread> {
    const t = await super.getThread(n);
    return { ...t, viewerCanUpdate: this.canUpdate, viewerCanDelete: this.canDelete };
  }
}

let dir: string;
let transport: RestrictedTransport;
let c: Ctx;
let output: string;
let spy: ReturnType<typeof vi.spyOn>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const bodyFile = (text: string) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "huddle-body-")), "body.md");
  writeFileSync(p, text);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "huddle-kb-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.ts"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  transport = new RestrictedTransport("alice");
  transport.writers.add("alice");
  transport.writers.add("bob");
  c = { root: dir, repo: DEFAULT_REPO_CONFIG, machine: parseMachineConfig(null), transport, me: "alice", slug: "o/r", publicThreads: false };
  output = "";
  spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    output += String(s);
    return true;
  });
});
afterEach(() => spy.mockRestore());

describe("kb helpers", () => {
  it("collapses whitespace and truncates snippets", () => {
    expect(snippet("a\n\n b   c")).toBe("a b c");
    expect([...snippet("字".repeat(300))].length).toBe(201);
  });
});

describe("publish", () => {
  it("creates a kb card with commit and files in meta", async () => {
    expect(await publish(c, bodyFile("card body"), { title: "T", files: ["a.ts"] })).toBe(0);
    const t = await transport.getThread(1);
    expect(t.category).toBe("kb");
    expect(t.messages[0].meta).toEqual({ type: "kb", files: ["a.ts"], commit: git("rev-parse", "HEAD") });
    expect(output).toContain("Published card #1");
  });

  it("supersedes an old card: closes it and appends a note", async () => {
    await publish(c, bodyFile("old"), { title: "Old", files: [] });
    await publish(c, bodyFile("new"), { title: "New", files: [], supersedes: "1" });
    const old = await transport.getThread(1);
    expect(old.closed).toBe(true);
    expect(old.messages[0].body).toContain("Superseded by #2");
    expect((await transport.getThread(2)).messages[0].meta?.supersedes).toBe("1");
  });

  it("is blocked for responders", async () => {
    vi.stubEnv("HUDDLE_RESPONDER", "1");
    try {
      await expect(publish(c, bodyFile("x"), { title: "T", files: [] })).rejects.toThrow(/HUDDLE_RESPONDER/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("kb edit / rm", () => {
  it("edits and deletes with permission", async () => {
    await publish(c, bodyFile("v1"), { title: "T", files: [] });
    await kbEdit(c, "1", bodyFile("v2"));
    expect((await transport.getThread(1)).messages[0].body).toBe("v2");
    await kbRm(c, "1", { yes: true });
    await expect(transport.getThread(1)).rejects.toThrow();
  });

  it("refreshes the baseline commit on edit", async () => {
    await publish(c, bodyFile("v1"), { title: "T", files: ["a.ts"] });
    const first = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "a.ts"), "y\n");
    git("commit", "-qam", "second");
    const head = git("rev-parse", "HEAD");
    expect(head).not.toBe(first);
    await kbEdit(c, "1", bodyFile("v2"));
    const meta = (await transport.getThread(1)).messages[0].meta;
    expect(meta).toMatchObject({ type: "kb", files: ["a.ts"], commit: head });
  });

  it("reports permission errors", async () => {
    await publish(c, bodyFile("v1"), { title: "T", files: [] });
    transport.canUpdate = false;
    transport.canDelete = false;
    await expect(kbEdit(c, "1", bodyFile("v2"))).rejects.toThrow(/do not have permission to edit/);
    await expect(kbRm(c, "1", { yes: true })).rejects.toThrow(/do not have permission to delete/);
    await expect(publish(c, bodyFile("n"), { title: "N", files: [], supersedes: "1" })).rejects.toThrow(/do not have permission to edit/);
  });

  it("rejects non-kb threads", async () => {
    await transport.createThread("ask", "Q", "q", { type: "ask", to: "bob" });
    await expect(kbRm(c, "1", { yes: true })).rejects.toThrow(/not a huddle knowledge card/);
  });

  it("rejects plain threads in the kb category", async () => {
    await transport.createThread("kb", "Welcome", "hi", null as never);
    await expect(kbEdit(c, "1", bodyFile("x"))).rejects.toThrow(/#1 is not a huddle knowledge card/);
    await expect(kbRm(c, "1", { yes: true })).rejects.toThrow(/not a huddle knowledge card/);
    await expect(publish(c, bodyFile("n"), { title: "N", files: [], supersedes: "1" })).rejects.toThrow(/not a huddle knowledge card/);
  });
});

describe("search", () => {
  it("lists KB first, at most 8, excluding closed", async () => {
    await transport.createThread("ask", "foo ask", "foo", { type: "ask", to: "bob" });
    for (let i = 0; i < 9; i++) await transport.createThread("kb", `foo kb ${i}`, "foo", { type: "kb" });
    const closed = await transport.createThread("kb", "foo closed", "foo", { type: "kb" });
    await transport.close(closed, "outdated");
    expect(await search(c, "foo")).toBe(0);
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads).toHaveLength(8);
    expect(heads.every((l) => l.startsWith("[KB #"))).toBe(true);
    expect(output).not.toContain("foo closed");
    expect(output).toContain("unknown");
  });

  it("falls back to ask threads after KB", async () => {
    await transport.createThread("ask", "foo ask", "foo", { type: "ask", to: "bob" });
    await transport.createThread("kb", "foo kb", "foo", { type: "kb" });
    await search(c, "foo");
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads[0]).toMatch(/^\[KB #2\]/);
    expect(heads[1]).toMatch(/^\[Q&A #1\]/);
  });

  it("classifies cards, Q&A and plain discussions", async () => {
    await transport.createThread("kb", "foo plain general", "foo", null as never);
    await transport.createThread("ask", "foo plain qa", "foo", null as never);
    await transport.createThread("ask", "foo ask", "foo", { type: "ask", to: "bob" });
    await transport.createThread("kb", "foo card", "foo", { type: "kb" });
    await search(c, "foo");
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads.map((l) => l.split("]")[0])).toEqual(["[KB #4", "[Q&A #3", "[Discussion #1", "[Discussion #2"]);
  });

  it("lists a kb-meta thread by a non-writer as a plain discussion", async () => {
    transport.as("mallory");
    await transport.createThread("kb", "foo fake card", "foo", { type: "kb" });
    await search(c, "foo");
    expect(output).toMatch(/^\[Discussion #1\]/m);
    expect(output).not.toContain("[KB #");
  });

  it("lists Q&A as a discussion unless both author and addressee have write access", async () => {
    await transport.createThread("ask", "foo good", "foo", { type: "ask", to: "bob" });
    await transport.createThread("ask", "foo to-outsider", "foo", { type: "ask", to: "zed" });
    transport.as("mallory");
    await transport.createThread("ask", "foo from-outsider", "foo", { type: "ask", to: "bob" });
    await search(c, "foo");
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads.map((l) => l.split("]")[0])).toEqual(["[Q&A #1", "[Discussion #2", "[Discussion #3"]);
  });

  it("only trusts answers from the addressee in Q&A snippets", async () => {
    const th = await transport.createThread("ask", "foo q", "foo question", { type: "ask", to: "bob" });
    transport.as("mallory");
    await transport.reply(th, "evil answer", { type: "answer", re: th.id });
    await search(c, "foo");
    expect(output).toContain("foo question");
    expect(output).not.toContain("evil answer");
  });

  it("labels cards with a real commit as fresh or stale", async () => {
    const commit = git("rev-parse", "HEAD");
    await transport.createThread("kb", "foo card", "foo", { type: "kb", commit, files: ["a.ts"] });
    await search(c, "foo");
    expect(output).toContain("[fresh]");
    writeFileSync(path.join(dir, "a.ts"), Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") + "\n");
    git("commit", "-qam", "big");
    output = "";
    await search(c, "foo");
    expect(output).toContain("[possibly stale]");
  });

  it("reports no results", async () => {
    await search(c, "zzz");
    expect(output).toContain("No related");
  });
});
