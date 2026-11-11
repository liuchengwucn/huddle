import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { findRepoRoot, loadMachineConfig, loadRepoConfig, type RepoConfig } from "../config.js";
import { selectBackend, versionCheck } from "../responder/backends/index.js";
import { GitHubClient, envToken } from "../transport/github-client.js";
import { HuddleError, PublicRepoError } from "../errors.js";
import { assertVisibility, buildTransport } from "./context.js";
import { SKILL_RELS, renderSkill, skillTemplateSync } from "./skill-version.js";
import type { Transport } from "../transport/types.js";

export { renderSkill };

const BEGIN = "<!-- huddle:begin -->";
const END = "<!-- huddle:end -->";
const out = (s: string) => process.stdout.write(`${s}\n`);

/** AGENTS.md block: a short pointer for agents that read AGENTS.md but not a skills directory; the skill itself loads on demand. */
export function agentsBlock(): string {
  return [
    BEGIN,
    "## huddle",
    "",
    "This repo uses huddle to message teammates' coding agents (questions, notifications, review requests, hand-offs) and to search or publish to the team knowledge base.",
    "Before using it, read `.agents/skills/huddle/SKILL.md`.",
    "If the environment variable `HUDDLE_RESPONDER=1` is set, do not use any huddle command.",
    END,
  ].join("\n");
}

export function upsertBlock(existing: string | null, block: string): string {
  if (!existing) return `${block}\n`;
  const a = existing.indexOf(BEGIN);
  const b = existing.indexOf(END);
  if (a >= 0 || b >= 0) {
    if (a < 0 || b < a) throw new HuddleError("The huddle markers in AGENTS.md are incomplete; fix them manually and retry");
  }
  if (a >= 0 && b > a) return existing.slice(0, a) + block + existing.slice(b + END.length);
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}

export interface GhLike {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

const REPO_INFO_QUERY = `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { visibility hasDiscussionsEnabled } }`;

async function repoInfo(gh: GhLike, owner: string, name: string): Promise<{ visibility: string; hasDiscussionsEnabled: boolean } | null> {
  const d = await gh.graphql<{ repository: { visibility: string; hasDiscussionsEnabled: boolean } | null }>(REPO_INFO_QUERY, { o: owner, n: name });
  return d.repository;
}

const msgOf = (json: unknown): string => String((json as { message?: unknown } | null)?.message ?? "");

/** Presence of a usable token: env var, or a working `gh auth token`. */
export function tokenAvailable(): boolean {
  if (envToken()) return true;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

async function writeSidecarConfig(root: string, sidecar: string): Promise<void> {
  const cfgPath = path.join(root, ".huddle", "config.yml");
  if (existsSync(cfgPath)) {
    const doc = YAML.parseDocument(await readFile(cfgPath, "utf8"));
    if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
    doc.set("repo", sidecar);
    await writeFile(cfgPath, String(doc));
  } else {
    await mkdir(path.dirname(cfgPath), { recursive: true });
    await writeFile(cfgPath, `# huddle repo config (shared with the team). Every field has a default; see https://github.com/liuchengwucn/huddle/blob/main/docs/configuration.md\nrepo: ${sidecar}\n`);
  }
}

/**
 * Make sure there is a private transport repo with Discussions enabled.
 * For a non-private code repo without `repo:` / `public: true`, creates `<repo>-huddle` and records it in .huddle/config.yml.
 */
/** Side effects observable even if ensureTransportRepo later throws. */
export interface EnsureState {
  configWritten?: boolean;
  /** The transport repo was created or had Discussions enabled in this run. */
  fresh?: boolean;
}

export async function ensureTransportRepo(
  gh: GhLike,
  root: string,
  code: { owner: string; repo: string },
  me: string,
  write: (s: string) => void,
  state: EnsureState = {},
): Promise<{ ok: boolean; configWritten: boolean }> {
  const cfg = await loadRepoConfig(root);
  let slug = cfg.repo ?? `${code.owner}/${code.repo}`;
  let configWritten = false;

  if (!cfg.repo && !cfg.public) {
    const info = await repoInfo(gh, code.owner, code.repo);
    if (!info) {
      write(`✗ Cannot read ${code.owner}/${code.repo} (does it exist, and does your token have access?)`);
      return { ok: false, configWritten };
    }
    if (info.visibility !== "PRIVATE") {
      const name = `${code.repo}-huddle`;
      const sidecar = `${code.owner}/${name}`;
      const manual = [
        `  Create a private repository ${sidecar} yourself (the code repo owner can do this),`,
        `  enable Discussions on it, and add "repo: ${sidecar}" to .huddle/config.yml.`,
      ].join("\n");
      const owner = await gh.rest("GET", `/users/${code.owner}`);
      const type = (owner.json as { type?: string } | null)?.type;
      let createPath: string | null = null;
      if (type === "Organization") createPath = `/orgs/${code.owner}/repos`;
      else if (type === "User" && code.owner.toLowerCase() === me.toLowerCase()) createPath = "/user/repos";
      if (!createPath) {
        write(`✗ ${code.owner}/${code.repo} is public and belongs to another user, so huddle cannot create a private companion repository for you.\n${manual}`);
        return { ok: false, configWritten };
      }
      const res = await gh.rest("POST", createPath, {
        name,
        private: true,
        has_discussions: true,
        description: `huddle messages for ${code.owner}/${code.repo}`,
      });
      if (res.status === 201) {
        write(`✓ Created private companion repository ${sidecar}`);
        state.fresh = true;
      } else if (res.status === 422) {
        const ex = await gh.rest("GET", `/repos/${sidecar}`);
        const exj = ex.json as { visibility?: string } | null;
        if (ex.status === 200 && exj?.visibility === "private") {
          write(`✓ Using existing private companion repository ${sidecar}`);
        } else if (ex.status === 200) {
          write(`✗ ${sidecar} exists but is not private (visibility: ${exj?.visibility}); make it private or set another repo in .huddle/config.yml`);
          return { ok: false, configWritten };
        } else {
          write(`✗ Could not create ${sidecar}: HTTP 422 ${msgOf(res.json)}\n${manual}`);
          return { ok: false, configWritten };
        }
      } else {
        write(`✗ Could not create ${sidecar}: HTTP ${res.status} ${msgOf(res.json)}\n${manual}`);
        return { ok: false, configWritten };
      }
      await writeSidecarConfig(root, sidecar);
      configWritten = true;
      state.configWritten = true;
      slug = sidecar;
    }
  }

  const [o, n] = slug.split("/");
  const info = await repoInfo(gh, o, n);
  if (!info) {
    write(`✗ Cannot read ${slug} (does it exist, and does your token have access?)`);
    return { ok: false, configWritten };
  }
  if (!info.hasDiscussionsEnabled) {
    if (info.visibility !== "PRIVATE" && !cfg.public) {
      write(`✗ ${slug} is not private (visibility: ${info.visibility}), so huddle will not change its settings. Make it private, or set "public: true" in .huddle/config.yml to accept public threads.`);
      return { ok: false, configWritten };
    }
    const r = await gh.rest("PATCH", `/repos/${slug}`, { has_discussions: true });
    if (r.status === 200) {
      write(`✓ Enabled Discussions on ${slug}`);
      state.fresh = true;
    } else {
      write(`✗ Could not enable Discussions on ${slug} (HTTP ${r.status}): enable it in Settings → General → Features → Discussions.`);
      return { ok: false, configWritten };
    }
  }
  return { ok: true, configWritten };
}

/** Visibility and Discussions/category problems of the transport; retries once after 3 s when the repo is fresh. */
export async function transportProblems(
  transport: Pick<Transport, "isPrivate" | "checkSetup">,
  cfg: RepoConfig,
  slug: string,
  fresh: boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string[]> {
  try {
    await assertVisibility(transport as Transport, cfg, slug, true);
  } catch (e) {
    if (e instanceof PublicRepoError) return [e.message];
    throw e;
  }
  let problems = await transport.checkSetup();
  if (problems.length && fresh) {
    await sleep(3000);
    problems = await transport.checkSetup();
  }
  return problems;
}

export async function init(opts: { repo?: string }): Promise<number> {
  let bad = 0;
  const check = (ok: boolean, label: string, hint = "") => {
    out(`${ok ? "✓" : "✗"} ${label}${!ok && hint ? `\n    → ${hint}` : ""}`);
    if (!ok) bad++;
  };
  const root = findRepoRoot(opts.repo ?? process.cwd());
  const skill = renderSkill(skillTemplateSync());

  for (const rel of SKILL_RELS) {
    const skillPath = path.join(root, rel);
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, skill);
    out(`✓ Wrote ${rel}`);
  }

  const agentsPath = path.join(root, "AGENTS.md");
  const existing = existsSync(agentsPath) ? await readFile(agentsPath, "utf8") : null;
  await writeFile(agentsPath, upsertBlock(existing, agentsBlock()));
  out(`✓ Updated the huddle block in AGENTS.md`);

  const state: EnsureState = {};
  let companion: string | null = null;
  const hasToken = tokenAvailable();
  check(hasToken, "GitHub token available", "set GH_TOKEN (or GITHUB_TOKEN), or install the GitHub CLI (https://cli.github.com) and run gh auth login");
  if (hasToken) {
    let slug = "the transport repo";
    try {
      const client = new GitHubClient();
      const me = (await client.graphql<{ viewer: { login: string } }>("query { viewer { login } }")).viewer.login;
      // buildTransport falls back to the transport repo as code repo when origin is unusable and repo: is set
      const { code } = buildTransport(root, await loadRepoConfig(root));
      const r = await ensureTransportRepo(client, root, code, me, out, state);
      if (!r.ok) bad++;
      else {
        const cfg = await loadRepoConfig(root);
        const built = buildTransport(root, cfg);
        slug = built.slug;
        if (slug.toLowerCase() !== `${code.owner}/${code.repo}`.toLowerCase()) companion = slug;
        let reachable = false;
        try {
          await built.transport.isPrivate(true);
          reachable = true;
        } catch (e) {
          check(false, `${slug} is reachable`, (e as Error).message);
        }
        if (reachable) {
          check(true, `${slug} is reachable`);
          const problems = await transportProblems(built.transport, cfg, slug, !!state.fresh);
          check(problems.length === 0, `${slug} visibility allowed, Discussions enabled and categories complete`, problems.join("\n    → "));
          check(await built.transport.hasWriteAccess(me), `${me} has write access to ${slug}`, "ask a repo admin to add you as a collaborator (write or higher)");
        }
      }
    } catch (e) {
      check(false, `GitHub access to ${slug}`, (e as Error).message);
    }
  }

  try {
    const backend = selectBackend(await loadMachineConfig());
    const v = versionCheck(backend);
    check(v.ok, `Backend ${backend.name}: ${backend.command.join(" ")} --version → ${v.output.split("\n")[0].slice(0, 80)}`,
      `The output does not mention ${backend.name === "claude" ? "Claude Code" : "codex"}. command may point at a different program (e.g. a shell function cc resolves to the C compiler in a non-interactive environment); write an executable wrapper script and set command.`);
  } catch (e) {
    check(false, "Backend command", (e as Error).message);
  }

  if (companion) out(`\nAdd your teammates as collaborators of ${companion}: https://github.com/${companion}/settings/access`);
  const addConfig = state.configWritten || hasUncommittedChanges(root, CONFIG_REL);
  out(`\nCommit these files: git add ${SKILL_RELS.join(" ")} AGENTS.md${addConfig ? ` ${CONFIG_REL}` : ""} && git commit -m "Add huddle"`);
  return bad ? 1 : 0;
}

const CONFIG_REL = ".huddle/config.yml";

/** True when the file is untracked or modified (e.g. written by an earlier init run but never committed). */
export function hasUncommittedChanges(root: string, rel: string): boolean {
  try {
    const s = execFileSync("git", ["status", "--porcelain", "--", rel], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return s.trim() !== "";
  } catch {
    return false;
  }
}
