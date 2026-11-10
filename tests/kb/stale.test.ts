import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { staleness } from "../../src/kb/stale.js";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "huddle-stale-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.ts"), lines(100, "a"));
  writeFileSync(path.join(dir, "b.ts"), lines(10, "b"));
  git("add", ".");
  git("commit", "-qm", "init");
});

describe("staleness", () => {
  it("is fresh after small changes and stale after large ones", () => {
    const commit = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "a.ts"), lines(95, "a") + lines(5, "x"));
    git("commit", "-qam", "small");
    expect(staleness({ type: "kb", commit, files: ["a.ts"] }, dir, 50)).toBe("fresh");
    writeFileSync(path.join(dir, "a.ts"), lines(100, "y"));
    git("commit", "-qam", "big");
    expect(staleness({ type: "kb", commit, files: ["a.ts"] }, dir, 50)).toBe("stale");
    expect(staleness({ type: "kb", commit, files: ["b.ts"] }, dir, 50)).toBe("fresh");
  });

  it("is stale when a file was deleted", () => {
    const commit = git("rev-parse", "HEAD");
    rmSync(path.join(dir, "b.ts"));
    git("commit", "-qam", "rm");
    expect(staleness({ type: "kb", commit, files: ["b.ts"] }, dir, 50)).toBe("stale");
  });

  it("is unknown without commit, files, or with an unknown commit", () => {
    expect(staleness({ type: "kb", files: ["a.ts"] }, dir, 50)).toBe("unknown");
    expect(staleness({ type: "kb", commit: git("rev-parse", "HEAD") }, dir, 50)).toBe("unknown");
    expect(staleness({ type: "kb", commit: "0".repeat(40), files: ["a.ts"] }, dir, 50)).toBe("unknown");
    expect(staleness(null, dir, 50)).toBe("unknown");
  });

  it("rejects non-hex or option-like commits without running git", () => {
    expect(staleness({ type: "kb", commit: "--output=/tmp/x", files: ["a.ts"] }, dir, 50)).toBe("unknown");
    expect(staleness({ type: "kb", commit: "zzzzzzz", files: ["a.ts"] }, dir, 50)).toBe("unknown");
    expect(staleness({ type: "kb", commit: "abc", files: ["a.ts"] }, dir, 50)).toBe("unknown");
  });
});
