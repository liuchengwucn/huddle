import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HuddleError } from "../../src/errors.js";
import YAML from "yaml";
import { agentsBlock, ensureTransportRepo, hasUncommittedChanges, renderSkill, transportProblems, upsertBlock, type GhLike } from "../../src/cli/setup.js";

const template = readFileSync(new URL("../../skill/SKILL.md", import.meta.url), "utf8");

describe("setup", () => {
  it("renders skill with version and frontmatter", () => {
    const s = renderSkill(template, "9.9.9");
    expect(s.startsWith("---\nname: huddle\n")).toBe(true);
    expect(s).toContain("<!-- huddle-skill-version: 9.9.9 -->");
    expect(s).not.toContain("{{VERSION}}");
  });

  it("builds a short AGENTS.md pointer to the skill", () => {
    const b = agentsBlock();
    expect(b.startsWith("<!-- huddle:begin -->\n## huddle")).toBe(true);
    expect(b.endsWith("<!-- huddle:end -->")).toBe(true);
    expect(b).toContain("`.agents/skills/huddle/SKILL.md`");
    expect(b).toContain("HUDDLE_RESPONDER=1");
    expect(b.split("\n").length).toBeLessThan(10);
  });

  it("upserts idempotently", () => {
    const b1 = "<!-- huddle:begin -->\nv1\n<!-- huddle:end -->";
    const b2 = "<!-- huddle:begin -->\nv2\n<!-- huddle:end -->";
    expect(upsertBlock(null, b1)).toBe(`${b1}\n`);
    const withOther = upsertBlock("# Project\n\nrules\n", b1);
    expect(withOther).toBe(`# Project\n\nrules\n\n${b1}\n`);
    const updated = upsertBlock(withOther, b2);
    expect(updated).toBe(`# Project\n\nrules\n\n${b2}\n`);
    expect(upsertBlock(updated, b2)).toBe(updated);
  });

  it("throws on incomplete markers", () => {
    const bad = "# P\n<!-- huddle:begin -->\nx\n";
    expect(() => upsertBlock(bad, "<!-- huddle:begin -->\nn\n<!-- huddle:end -->")).toThrow(HuddleError);
    expect(() => upsertBlock("<!-- huddle:end -->\n<!-- huddle:begin -->", "b")).toThrow(HuddleError);
  });
});

describe("skill guidance", () => {
  it("covers wait strategy per agent and never resending", () => {
    expect(template).toContain("--wait 540");
    expect(template).toContain("600000 ms");
    expect(template).toContain("--wait 30");
    expect(template).toContain("Never resend the message");
    expect((template.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe("ensureTransportRepo", () => {
  type Call = { method: string; path: string; body?: unknown };
  interface Opts {
    codeVis?: string;
    codeDiscussions?: boolean;
    ownerType?: string;
    post?: number;
    existing?: { status: number; visibility?: string };
    patch?: number;
    sidecarDiscussions?: boolean;
    sidecarVis?: string;
  }
  function stub(o: Opts = {}) {
    const calls: Call[] = [];
    const gh: GhLike = {
      async graphql<T>(_q: string, v?: Record<string, unknown>) {
        const isCode = v?.n === "app";
        const repository = isCode
          ? { visibility: o.codeVis ?? "PUBLIC", hasDiscussionsEnabled: o.codeDiscussions ?? true }
          : { visibility: o.sidecarVis ?? "PRIVATE", hasDiscussionsEnabled: o.sidecarDiscussions ?? true };
        return { repository } as T;
      },
      async rest(method, p, body) {
        calls.push({ method, path: p, body });
        if (method === "GET" && p.startsWith("/users/")) return { status: 200, json: { type: o.ownerType ?? "User" } };
        if (method === "POST") return { status: o.post ?? 201, json: { message: "boom" } };
        if (method === "GET" && p.startsWith("/repos/")) return { status: o.existing?.status ?? 404, json: { visibility: o.existing?.visibility } };
        if (method === "PATCH") return { status: o.patch ?? 200, json: {} };
        return { status: 500, json: {} };
      },
    };
    return { gh, calls };
  }
  const code = { owner: "me", repo: "app" };
  const mkroot = (cfg?: string) => {
    const root = mkdtempSync(path.join(tmpdir(), "huddle-setup-"));
    if (cfg !== undefined) {
      mkdirSync(path.join(root, ".huddle"));
      writeFileSync(path.join(root, ".huddle", "config.yml"), cfg);
    }
    return root;
  };
  const cfgText = (root: string) => readFileSync(path.join(root, ".huddle", "config.yml"), "utf8");
  const run = (gh: GhLike, root: string, c = code, me = "me") => {
    const lines: string[] = [];
    return ensureTransportRepo(gh, root, c, me, (s) => lines.push(s)).then((r) => ({ ...r, lines }));
  };
  const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

  it("creates a private companion for a public user repo owned by me", async () => {
    const { gh, calls } = stub();
    const root = mkroot();
    const r = await run(gh, root);
    expect(r).toMatchObject({ ok: true, configWritten: true });
    expect(posts(calls)).toEqual([
      { method: "POST", path: "/user/repos", body: { name: "app-huddle", private: true, has_discussions: true, description: "huddle messages for me/app" } },
    ]);
    expect(cfgText(root)).toContain("repo: me/app-huddle\n");
  });

  it("uses the org endpoint for organizations", async () => {
    const { gh, calls } = stub({ ownerType: "Organization" });
    const r = await run(gh, mkroot(), { owner: "acme", repo: "app" });
    expect(r.ok).toBe(true);
    expect(posts(calls)[0]).toEqual({
      method: "POST",
      path: "/orgs/acme/repos",
      body: { name: "app-huddle", private: true, has_discussions: true, description: "huddle messages for acme/app" },
    });
  });

  it("reuses an existing private repo on 422", async () => {
    const { gh } = stub({ post: 422, existing: { status: 200, visibility: "private" } });
    const root = mkroot();
    const r = await run(gh, root);
    expect(r).toMatchObject({ ok: true, configWritten: true });
    expect(cfgText(root)).toContain("repo: me/app-huddle");
  });

  it("422 reuse looks up the companion repo path", async () => {
    const { gh, calls } = stub({ post: 422, existing: { status: 200, visibility: "private" } });
    await run(gh, mkroot());
    expect(calls).toContainEqual({ method: "GET", path: "/repos/me/app-huddle", body: undefined });
  });

  it("rejects an existing internal companion repo", async () => {
    const { gh } = stub({ post: 422, existing: { status: 200, visibility: "internal" } });
    const root = mkroot();
    const r = await run(gh, root);
    expect(r).toMatchObject({ ok: false, configWritten: false });
    expect(r.lines.join("\n")).toContain("(visibility: internal)");
    expect(existsSync(path.join(root, ".huddle", "config.yml"))).toBe(false);
  });

  it("matches the owner case-insensitively", async () => {
    const { gh, calls } = stub();
    const r = await run(gh, mkroot(), { owner: "Me", repo: "app" }, "me");
    expect(r.ok).toBe(true);
    expect(posts(calls)[0].path).toBe("/user/repos");
  });

  it("treats an internal code repo as non-private", async () => {
    const { gh, calls } = stub({ codeVis: "INTERNAL", ownerType: "Organization" });
    const r = await run(gh, mkroot(), { owner: "acme", repo: "app" });
    expect(r.ok).toBe(true);
    expect(posts(calls)).toHaveLength(1);
  });

  it("enables Discussions on the companion, not the code repo", async () => {
    const { gh, calls } = stub({ sidecarDiscussions: false });
    const r = await run(gh, mkroot());
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual({ method: "PATCH", path: "/repos/me/app-huddle", body: { has_discussions: true } });
    expect(calls.some((c) => c.path === "/repos/me/app")).toBe(false);
  });

  it("records state before later steps can fail", async () => {
    const { gh } = stub({ sidecarDiscussions: false });
    const state: { configWritten?: boolean; fresh?: boolean } = {};
    await ensureTransportRepo(gh, mkroot(), code, "me", () => {}, state);
    expect(state).toEqual({ configWritten: true, fresh: true });
  });

  it("repairs non-map config documents", async () => {
    for (const text of ["---\n# c\n", "null\n", "~\n", ""]) {
      const { gh } = stub();
      const root = mkroot(text);
      await run(gh, root);
      expect(YAML.parse(cfgText(root))).toEqual({ repo: "me/app-huddle" });
    }
  });

  it("fails on 422 when the existing repo is public", async () => {
    const { gh } = stub({ post: 422, existing: { status: 200, visibility: "public" } });
    const root = mkroot();
    const r = await run(gh, root);
    expect(r).toMatchObject({ ok: false, configWritten: false });
    expect(r.lines.join("\n")).toContain("exists but is not private");
    expect(existsSync(path.join(root, ".huddle", "config.yml"))).toBe(false);
  });

  it("fails on 422 when nothing exists", async () => {
    const { gh } = stub({ post: 422, existing: { status: 404 } });
    const r = await run(gh, mkroot());
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("HTTP 422");
  });

  it("does not create a repo under someone else's account", async () => {
    const { gh, calls } = stub();
    const r = await run(gh, mkroot(), { owner: "other", repo: "app" });
    expect(r).toMatchObject({ ok: false, configWritten: false });
    expect(posts(calls)).toEqual([]);
    expect(r.lines.join("\n")).toContain("repo: other/app-huddle");
  });

  it("reports other HTTP errors", async () => {
    const { gh } = stub({ post: 403 });
    const r = await run(gh, mkroot());
    expect(r).toMatchObject({ ok: false, configWritten: false });
    expect(r.lines.join("\n")).toContain("Could not create me/app-huddle: HTTP 403 boom");
  });

  it("enables Discussions on a private code repo", async () => {
    const { gh, calls } = stub({ codeVis: "PRIVATE", codeDiscussions: false });
    const r = await run(gh, mkroot());
    expect(r).toMatchObject({ ok: true, configWritten: false });
    expect(calls).toContainEqual({ method: "PATCH", path: "/repos/me/app", body: { has_discussions: true } });
    expect(posts(calls)).toEqual([]);
  });

  it("reports failure to enable Discussions", async () => {
    const { gh } = stub({ codeVis: "PRIVATE", codeDiscussions: false, patch: 403 });
    const r = await run(gh, mkroot());
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("Could not enable Discussions on me/app (HTTP 403)");
  });

  it("does not enable Discussions on a non-private transport unless public: true", async () => {
    const a = stub({ sidecarDiscussions: false, sidecarVis: "PUBLIC" });
    const r = await run(a.gh, mkroot("repo: me/other-huddle\n"));
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("not private");
    expect(a.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    const b = stub({ sidecarDiscussions: false, sidecarVis: "PUBLIC" });
    const r2 = await run(b.gh, mkroot("repo: me/other-huddle\npublic: true\n"));
    expect(r2.ok).toBe(true);
    expect(b.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("checks Discussions on the configured repo without creating anything", async () => {
    const { gh, calls } = stub({ sidecarDiscussions: false });
    const r = await run(gh, mkroot("repo: me/other-huddle\n"));
    expect(r).toMatchObject({ ok: true, configWritten: false });
    expect(calls).toEqual([{ method: "PATCH", path: "/repos/me/other-huddle", body: { has_discussions: true } }]);
  });

  it("preserves comments when adding repo to an existing config", async () => {
    const { gh } = stub();
    const root = mkroot("# keep me\ncategories:\n  kb: Knowledge # inline\n");
    await run(gh, root);
    const t = cfgText(root);
    expect(t).toContain("# keep me");
    expect(t).toContain("# inline");
    expect(t).toContain("repo: me/app-huddle");
  });

  it("does not create a companion when public: true", async () => {
    const { gh, calls } = stub({ codeDiscussions: true });
    const r = await run(gh, mkroot("public: true\n"));
    expect(r).toMatchObject({ ok: true, configWritten: false });
    expect(calls).toEqual([]);
  });
});

describe("transportProblems", () => {
  const cfg = { public: false } as never;
  const t = (vis: boolean, seq: string[][]) => {
    let i = 0;
    return { isPrivate: async () => vis, checkSetup: async () => seq[Math.min(i++, seq.length - 1)] };
  };
  it("reports a public configured repo", async () => {
    const p = await transportProblems(t(false, [[]]), cfg, "o/r", false);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("not private");
  });
  it("retries once for fresh repos", async () => {
    let slept = 0;
    const p = await transportProblems(t(true, [["missing"], []]), cfg, "o/r", true, async () => { slept++; });
    expect(p).toEqual([]);
    expect(slept).toBe(1);
  });
  it("does not retry for existing repos", async () => {
    const p = await transportProblems(t(true, [["missing"], []]), cfg, "o/r", false, async () => { throw new Error("no"); });
    expect(p).toEqual(["missing"]);
  });
});

describe("hasUncommittedChanges", () => {
  it("reports an untracked config, but not a committed or missing one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "huddle-cfg-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    expect(hasUncommittedChanges(root, ".huddle/config.yml")).toBe(false);
    mkdirSync(path.join(root, ".huddle"));
    writeFileSync(path.join(root, ".huddle", "config.yml"), "repo: o/r-huddle\n");
    expect(hasUncommittedChanges(root, ".huddle/config.yml")).toBe(true);
    git("add", ".");
    git("commit", "-q", "-m", "c");
    expect(hasUncommittedChanges(root, ".huddle/config.yml")).toBe(false);
  });
});
