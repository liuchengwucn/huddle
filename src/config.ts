import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { HuddleError } from "./errors.js";
import { machineConfigPath } from "./core/paths.js";

export interface RepoConfig {
  transport: "github-discussions";
  /** "owner/name" of the repo that stores huddle threads; absent → the code repo itself. */
  repo?: string;
  /** Allow threads in a public repository (visible to everyone). */
  public: boolean;
  categories: { ask: string; kb: string };
  limits: { rounds_per_thread: number; answers_per_hour: number; responder_timeout_minutes: number };
  kb: { stale_lines: number };
}

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  transport: "github-discussions",
  public: false,
  categories: { ask: "Q&A", kb: "General" },
  limits: { rounds_per_thread: 8, answers_per_hour: 20, responder_timeout_minutes: 10 },
  kb: { stale_lines: 50 },
};

export interface MachineConfig {
  backend?: "claude" | "codex";
  command?: string[];
  permission_mode: "auto" | "bypassPermissions";
  extra_context_dirs: string[];
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
  const r = (raw ?? {}) as Partial<Record<Exclude<keyof RepoConfig, "transport" | "repo" | "public">, Record<string, unknown>>> & {
    transport?: unknown;
    repo?: unknown;
    public?: unknown;
  };
  const cfg: RepoConfig = {
    transport: "github-discussions",
    public: false,
    categories: { ...DEFAULT_REPO_CONFIG.categories, ...(r.categories ?? {}) } as RepoConfig["categories"],
    limits: { ...DEFAULT_REPO_CONFIG.limits, ...(r.limits ?? {}) } as RepoConfig["limits"],
    kb: { ...DEFAULT_REPO_CONFIG.kb, ...(r.kb ?? {}) } as RepoConfig["kb"],
  };
  if (r.transport !== undefined && r.transport !== "github-discussions") {
    throw new HuddleError(`Unsupported transport: ${String(r.transport)}`);
  }
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
  for (const [k, v] of Object.entries({ ...cfg.limits, ...cfg.kb })) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new HuddleError(`Config key ${k} must be a positive number`);
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
  const cfg: MachineConfig = {
    permission_mode: "auto",
    extra_context_dirs: [],
  };
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
  if (r.extra_context_dirs !== undefined) {
    if (!Array.isArray(r.extra_context_dirs) || !r.extra_context_dirs.every((s) => typeof s === "string")) {
      throw new HuddleError("extra_context_dirs must be an array of strings");
    }
    cfg.extra_context_dirs = r.extra_context_dirs as string[];
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
