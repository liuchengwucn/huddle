import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HuddleError } from "../../src/errors.js";
import { DEFAULT_LIMITS, DEFAULT_REPO_CONFIG, loadRepoConfig, mergeRepoConfig, parseGitHubRemote, parseMachineConfig, parseSlug } from "../../src/config.js";

describe("config", () => {
  it("pins literal defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({ rounds_per_thread: 8, replies_per_hour: 20, timeout_minutes: 10 });
    expect(DEFAULT_REPO_CONFIG).toEqual({ public: false, categories: { messages: "Q&A", cards: "General" } });
  });

  it("defaults to zero-config categories and a private-only transport", () => {
    expect(mergeRepoConfig(null)).toEqual(DEFAULT_REPO_CONFIG);
    expect(mergeRepoConfig(null).repo).toBeUndefined();
  });

  it("validates repo and public", () => {
    expect(mergeRepoConfig({ repo: "a/b" }).repo).toBe("a/b");
    expect(() => mergeRepoConfig({ repo: "a" })).toThrow(/owner\/name/);
    expect(() => mergeRepoConfig({ repo: "a/b/c" })).toThrow(/owner\/name/);
    expect(mergeRepoConfig({ public: true }).public).toBe(true);
    expect(() => mergeRepoConfig({ public: "yes" })).toThrow(/public/);
    expect(parseSlug("a/b")).toEqual({ owner: "a", repo: "b" });
  });

  it("merges categories and ignores old keys", () => {
    expect(mergeRepoConfig({ categories: { cards: "Cards" } }).categories).toEqual({ messages: "Q&A", cards: "Cards" });
    expect(() => mergeRepoConfig({ categories: { messages: "" } })).toThrow(/categories.messages/);
    const old = mergeRepoConfig({ transport: "other", limits: { rounds_per_thread: -1 }, kb: { stale_lines: 1 }, categories: { ask: "X", kb: "Y" } });
    expect(old).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("throws HuddleError on YAML syntax errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "huddle-cfg-"));
    await mkdir(path.join(root, ".huddle"));
    await writeFile(path.join(root, ".huddle", "config.yml"), "categories: [unclosed\n  : : :\n");
    await expect(loadRepoConfig(root)).rejects.toThrow(HuddleError);
    await expect(loadRepoConfig(root)).rejects.toThrow(/not valid YAML/);
  });

  it("parses GitHub remotes", () => {
    for (const url of [
      "git@github.com:acme/widget.git",
      "https://github.com/acme/widget.git",
      "https://github.com/acme/widget",
      "https://token@github.com/acme/widget.git",
      "ssh://git@github.com/acme/widget.git",
    ]) {
      expect(parseGitHubRemote(url)).toEqual({ owner: "acme", repo: "widget" });
    }
    expect(parseGitHubRemote("git@gitlab.com:acme/widget.git")).toBeNull();
  });

  it("validates machine config", () => {
    expect(parseMachineConfig(null)).toEqual({ permission_mode: "auto", limits: DEFAULT_LIMITS });
    expect(parseMachineConfig({ backend: "codex", command: ["/x/wrap"] })).toMatchObject({ backend: "codex", command: ["/x/wrap"] });
    expect(() => parseMachineConfig({ command: "cc" })).toThrow(/array/);
    expect(() => parseMachineConfig({ permission_mode: "yolo" })).toThrow();
  });

  it("parses machine limits over defaults", () => {
    expect(parseMachineConfig({ limits: { rounds_per_thread: 3 } }).limits).toEqual({ ...DEFAULT_LIMITS, rounds_per_thread: 3 });
    expect(parseMachineConfig({ limits: null }).limits).toEqual(DEFAULT_LIMITS);
    expect(parseMachineConfig({ limits: { bogus: 1 } }).limits).toEqual(DEFAULT_LIMITS);
    expect(() => parseMachineConfig({ limits: { replies_per_hour: -1 } })).toThrow("Config key limits.replies_per_hour must be a positive integer");
    expect(() => parseMachineConfig({ limits: { timeout_minutes: "10" } })).toThrow("Config key limits.timeout_minutes must be a positive number");
    expect(() => parseMachineConfig({ limits: [1] })).toThrow(/mapping/);
    expect(() => parseMachineConfig({ limits: { rounds_per_thread: 2.5 } })).toThrow("Config key limits.rounds_per_thread must be a positive integer");
    expect(() => parseMachineConfig({ limits: { replies_per_hour: 0.5 } })).toThrow(/replies_per_hour must be a positive integer/);
    expect(parseMachineConfig({ limits: { timeout_minutes: 0.5 } }).limits.timeout_minutes).toBe(0.5);
    expect(parseMachineConfig(null).limits).not.toBe(DEFAULT_LIMITS);
  });
});
