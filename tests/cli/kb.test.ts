import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { signature } from "../../src/core/signature.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish, search, snippet } from "../../src/cli/kb.js";
import type { Ctx } from "../../src/cli/context.js";
import { DEFAULT_REPO_CONFIG, parseMachineConfig } from "../../src/config.js";
import type { Thread } from "../../src/core/types.js";
import { FakeTransport } from "../../src/transport/fake.js";

/** Test helper: can force viewerCanUpdate to false. */
class RestrictedTransport extends FakeTransport {
  canUpdate = true;
  override async getThread(n: number): Promise<Thread> {
    const t = await super.getThread(n);
    return { ...t, viewerCanUpdate: this.canUpdate };
  }
}

let transport: RestrictedTransport;
let c: Ctx;
let output: string;
let spy: ReturnType<typeof vi.spyOn>;
const bodyFile = (text: string) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "huddle-body-")), "body.md");
  writeFileSync(p, text);
  return p;
};

beforeEach(() => {
  transport = new RestrictedTransport("alice");
  transport.writers.add("alice");
  transport.writers.add("bob");
  c = { root: tmpdir(), repo: DEFAULT_REPO_CONFIG, machine: parseMachineConfig(null), transport, me: "alice", slug: "o/r", publicThreads: false };
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
  it("creates a card with plain card metadata", async () => {
    expect(await publish(c, bodyFile("card body"), { title: "T" })).toBe(0);
    const t = await transport.getThread(1);
    expect(t.category).toBe("cards");
    expect(t.messages[0].meta).toEqual({ type: "card" });
    expect(output).toContain("Published card #1");
  });

  it("replaces title and body in place with --edit", async () => {
    await publish(c, bodyFile("v1"), { title: "T1" });
    expect(await publish(c, bodyFile("v2"), { title: "T2", edit: "#1" })).toBe(0);
    const t = await transport.getThread(1);
    expect(t.title).toBe("T2");
    expect(t.messages[0].body).toBe("v2" + signature("Updated by alice"));
    expect(t.messages[0].meta).toEqual({ type: "card" });
    expect(output).toContain("Updated card #1");
    await expect(transport.getThread(2)).rejects.toThrow();
  });

  it("requires edit permission for --edit", async () => {
    await publish(c, bodyFile("v1"), { title: "T" });
    transport.canUpdate = false;
    await expect(publish(c, bodyFile("v2"), { title: "T", edit: "1" })).rejects.toThrow(/do not have permission to edit card #1/);
    expect((await transport.getThread(1)).messages[0].body).toBe("v1" + signature("Published by alice"));
  });

  it("rejects --edit on message threads and plain threads", async () => {
    await transport.createThread("messages", "Q", "q", { type: "message", to: "bob" });
    await expect(publish(c, bodyFile("x"), { title: "T", edit: "1" })).rejects.toThrow(/#1 is not a huddle knowledge card/);
    await transport.createThread("cards", "Welcome", "hi", null as never);
    await expect(publish(c, bodyFile("x"), { title: "T", edit: "2" })).rejects.toThrow(/#2 is not a huddle knowledge card/);
  });

  it("rejects an empty body and is blocked for responders", async () => {
    await expect(publish(c, bodyFile("  \n"), { title: "T" })).rejects.toThrow(/must not be empty/);
    vi.stubEnv("HUDDLE_RESPONDER", "1");
    try {
      await expect(publish(c, bodyFile("x"), { title: "T" })).rejects.toThrow(/HUDDLE_RESPONDER/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("search", () => {
  it("lists cards first, at most 8, excluding closed, with the update date", async () => {
    await transport.createThread("messages", "foo msg", "foo", { type: "message", to: "bob" });
    for (let i = 0; i < 9; i++) await transport.createThread("cards", `foo card ${i}`, "foo", { type: "card" });
    const closed = await transport.createThread("cards", "foo closed", "foo", { type: "card" });
    transport.closeThread(closed);
    expect(await search(c, "foo")).toBe(0);
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads).toHaveLength(8);
    expect(heads.every((l) => /^\[Card #\d+\] \(updated \d{4}-\d{2}-\d{2}\) foo card/.test(l))).toBe(true);
    expect(output).not.toContain("foo closed");
  });

  it("dates cards by their last edit, not by comments", async () => {
    transport = new RestrictedTransport("alice", Date.parse("2026-11-01T23:59:58Z"));
    transport.writers.add("alice");
    c = { ...c, transport };
    await publish(c, bodyFile("foo v1"), { title: "foo" }); // 2026-11-01T23:59:59
    transport.humanComment(await transport.getThread(1), "thanks"); // 2026-11-02
    output = "";
    await search(c, "foo");
    expect(output).toContain("[Card #1] (updated 2026-11-01) foo");
    await publish(c, bodyFile("foo v2"), { title: "foo", edit: "1" });
    output = "";
    await search(c, "foo");
    expect(output).toContain("[Card #1] (updated 2026-11-02) foo");
  });

  it("classifies cards, threads and plain discussions", async () => {
    await transport.createThread("cards", "foo plain general", "foo", null as never);
    await transport.createThread("messages", "foo plain qa", "foo", null as never);
    await transport.createThread("messages", "foo msg", "foo", { type: "message", to: "bob" });
    await transport.createThread("cards", "foo card", "foo", { type: "card" });
    await search(c, "foo");
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads.map((l) => l.split("]")[0])).toEqual(["[Card #4", "[Thread #3", "[Discussion #1", "[Discussion #2"]);
  });

  it("lists a card-meta thread by a non-writer as a plain discussion", async () => {
    transport.as("mallory");
    await transport.createThread("cards", "foo fake card", "foo", { type: "card" });
    await search(c, "foo");
    expect(output).toMatch(/^\[Discussion #1\]/m);
    expect(output).not.toContain("[Card #");
  });

  it("lists a thread as a discussion unless both sender and addressee have write access", async () => {
    await transport.createThread("messages", "foo good", "foo", { type: "message", to: "bob" });
    await transport.createThread("messages", "foo to-outsider", "foo", { type: "message", to: "zed" });
    transport.as("mallory");
    await transport.createThread("messages", "foo from-outsider", "foo", { type: "message", to: "bob" });
    await search(c, "foo");
    const heads = output.split("\n").filter((l) => l.startsWith("["));
    expect(heads.map((l) => l.split("]")[0])).toEqual(["[Thread #1", "[Discussion #2", "[Discussion #3"]);
  });

  it("only trusts replies from the addressee in thread snippets", async () => {
    const th = await transport.createThread("messages", "foo q", "foo question", { type: "message", to: "bob" });
    transport.as("mallory");
    await transport.reply(th, "evil reply", { type: "reply", re: th.id });
    await search(c, "foo");
    expect(output).toContain("foo question");
    expect(output).not.toContain("evil reply");
    transport.as("bob");
    await transport.reply(th, "good reply", { type: "reply", re: th.id });
    output = "";
    await search(c, "foo");
    expect(output).toContain("good reply");
  });

  it("reports no results", async () => {
    await search(c, "zzz");
    expect(output).toContain("No related cards or past threads found.");
  });
});
