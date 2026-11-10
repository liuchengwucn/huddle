import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HuddleError } from "../../src/errors.js";
import { DEFAULT_REPO_CONFIG, loadRepoConfig, mergeRepoConfig, parseGitHubRemote, parseMachineConfig, parseSlug } from "../../src/config.js";

describe("config", () => {
  it("pins literal defaults", () => {
    expect(DEFAULT_REPO_CONFIG.limits).toEqual({ rounds_per_thread: 8, answers_per_hour: 20, responder_timeout_minutes: 10 });
    expect(DEFAULT_REPO_CONFIG.kb.stale_lines).toBe(50);
    expect(DEFAULT_REPO_CONFIG.categories).toEqual({ ask: "Q&A", kb: "General" });
  });

  it("defaults to zero-config categories and a private-only transport", () => {
    expect(DEFAULT_REPO_CONFIG.public).toBe(false);
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

  it("throws HuddleError on YAML syntax errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "huddle-cfg-"));
    await mkdir(path.join(root, ".huddle"));
    await writeFile(path.join(root, ".huddle", "config.yml"), "limits: [unclosed\n  : : :\n");
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

  it("merges repo config with defaults", () => {
    expect(mergeRepoConfig(null)).toEqual(DEFAULT_REPO_CONFIG);
    const c = mergeRepoConfig({ limits: { rounds_per_thread: 3 } });
    expect(c.limits).toEqual({ ...DEFAULT_REPO_CONFIG.limits, rounds_per_thread: 3 });
    expect(() => mergeRepoConfig({ limits: { answers_per_hour: -1 } })).toThrow();
  });

  it("validates machine config", () => {
    expect(parseMachineConfig(null)).toEqual({ permission_mode: "auto", extra_context_dirs: [] });
    expect(parseMachineConfig({ backend: "codex", command: ["/x/wrap"] })).toMatchObject({ backend: "codex", command: ["/x/wrap"] });
    expect(() => parseMachineConfig({ command: "cc" })).toThrow(/array/);
    expect(() => parseMachineConfig({ permission_mode: "yolo" })).toThrow();
  });
});
