import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { HuddleError } from "./errors.js";
import { machineConfigPath } from "./core/paths.js";

export interface RepoConfig {
  /** "owner/name" of the repo that stores huddle threads; absent → the code repo itself. */
  repo?: string;
  /** Allow threads in a public repository (visible to everyone). */
  public: boolean;
  categories: { messages: string; kb: string };
}

export const DEFAULT_REPO_CONFIG: RepoConfig = { public: false, categories: { messages: "Q&A", kb: "General" } };

export interface Limits { rounds_per_thread: number; replies_per_hour: number; timeout_minutes: number }
export const DEFAULT_LIMITS: Limits = { rounds_per_thread: 8, replies_per_hour: 20, timeout_minutes: 10 };

export interface MachineConfig {
  backend?: "claude" | "codex";
  command?: string[];
  permission_mode: "auto" | "bypassPermissions";
  limits: Limits;
}

async function readYaml(file: string): Promise<Record<string, unknown> | null> {
  let txt: string;
  try {
    txt = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HuddleError(`Cannot read ${file}: ${(e as Error).message}`);
  }
  let v: unknown;
  try {
    v = YAML.parse(txt) ?? {};
  } catch (e) {
    throw new HuddleError(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HuddleError(`${file} must contain a YAML mapping`);
  return v as Record<string, unknown>;
}

export function mergeRepoConfig(raw: Record<string, unknown> | null): RepoConfig {
  const r = (raw ?? {}) as { repo?: unknown; public?: unknown; categories?: Record<string, unknown> };
  const cats = r.categories ?? {};
  const cfg: RepoConfig = {
    public: false,
    categories: { messages: cats.messages ?? DEFAULT_REPO_CONFIG.categories.messages, kb: cats.kb ?? DEFAULT_REPO_CONFIG.categories.kb } as RepoConfig["categories"],
  };
  if (r.repo !== undefined) {
    if (typeof r.repo !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r.repo)) {
      throw new HuddleError('Config key repo must look like "owner/name"');
    }
    cfg.repo = r.repo;
  }
  if (r.public !== undefined) {
    if (typeof r.public !== "boolean") throw new HuddleError("Config key public must be true or false");
    cfg.public = r.public;
  }
  for (const [k, v] of Object.entries(cfg.categories)) {
    if (typeof v !== "string" || !v) throw new HuddleError(`Config key categories.${k} must be a non-empty string`);
  }
  return cfg;
}

export function parseSlug(s: string): { owner: string; repo: string } {
  const [owner, repo] = s.split("/");
  return { owner, repo };
}

export function parseMachineConfig(raw: Record<string, unknown> | null): MachineConfig {
  const r = raw ?? {};
  const cfg: MachineConfig = { permission_mode: "auto", limits: { ...DEFAULT_LIMITS } };
  if (r.backend !== undefined) {
    if (r.backend !== "claude" && r.backend !== "codex") throw new HuddleError("backend must be claude or codex");
    cfg.backend = r.backend;
  }
  if (r.command !== undefined) {
    if (!Array.isArray(r.command) || r.command.length === 0 || !r.command.every((s) => typeof s === "string" && s)) {
      throw new HuddleError('command must be a non-empty array of strings, e.g. ["/path/to/wrapper"] (it is not run through a shell, so a plain string is not allowed)');
    }
    cfg.command = r.command as string[];
  }
  if (r.permission_mode !== undefined) {
    if (r.permission_mode !== "auto" && r.permission_mode !== "bypassPermissions") {
      throw new HuddleError("permission_mode must be auto or bypassPermissions");
    }
    cfg.permission_mode = r.permission_mode;
  }
  if (r.limits !== undefined && r.limits !== null) {
    if (typeof r.limits !== "object" || Array.isArray(r.limits)) throw new HuddleError("Config key limits must be a mapping");
    const l = r.limits as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
      const v = l[k];
      if (v === undefined) continue;
      const int = k !== "timeout_minutes";
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (int && !Number.isInteger(v))) {
        throw new HuddleError(`Config key limits.${k} must be a positive ${int ? "integer" : "number"}`);
      }
      cfg.limits[k] = v;
    }
  }
  return cfg;
}

export async function loadRepoConfig(root: string): Promise<RepoConfig> {
  return mergeRepoConfig(await readYaml(path.join(root, ".huddle", "config.yml")));
}

export async function loadMachineConfig(): Promise<MachineConfig> {
  return parseMachineConfig(await readYaml(machineConfigPath()));
}

export function findRepoRoot(start: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" }).trim();
  } catch {
    throw new HuddleError(`${start} is not inside a git repository. Run from the project repo, or pass --repo.`);
  }
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function repoSlug(root: string): { owner: string; repo: string } {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  } catch {
    throw new HuddleError("The repository has no origin remote, so the GitHub repo cannot be determined.");
  }
  const slug = parseGitHubRemote(url);
  if (!slug) throw new HuddleError(`origin is not a GitHub repository: ${url.trim()}`);
  return slug;
}
