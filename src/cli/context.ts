import { findRepoRoot, loadMachineConfig, loadRepoConfig, parseSlug, repoSlug, type MachineConfig, type RepoConfig } from "../config.js";
import { HuddleError, PublicRepoError } from "../errors.js";
import { GitHubClient } from "../transport/github-client.js";
import { GitHubDiscussions } from "../transport/github-discussions.js";
import type { Transport } from "../transport/types.js";

export interface Ctx {
  root: string;
  repo: RepoConfig;
  machine: MachineConfig;
  transport: Transport;
  me: string;
  /** "owner/name" of the transport repo. */
  slug: string;
  /** Threads are publicly visible (only possible with `public: true`). */
  publicThreads: boolean;
}

export async function assertVisibility(t: Transport, cfg: RepoConfig, slug: string, fresh = false): Promise<boolean> {
  const isPrivate = await t.isPrivate(fresh);
  if (!isPrivate && !cfg.public) {
    throw new PublicRepoError(
      `${slug} is not private (visibility: public or internal), so huddle threads there would be visible beyond you and your collaborators. ` +
        `Run "npx -y huddle-agent@latest init" to set up a private companion repository, ` +
        `or set "public: true" in .huddle/config.yml to discuss in the open.`,
    );
  }
  return !isPrivate;
}

/** Transport repo = `repo:` from config, else the code repo; commits resolve against the code repo. */
export function buildTransport(root: string, repo: RepoConfig): { transport: GitHubDiscussions; slug: string; code: { owner: string; repo: string } } {
  const target = repo.repo ? parseSlug(repo.repo) : repoSlug(root);
  let code = target;
  if (repo.repo) {
    try {
      code = repoSlug(root);
    } catch {
      // no usable origin: resolve emails against the transport repo
    }
  }
  const transport = new GitHubDiscussions(new GitHubClient(), target.owner, target.repo, repo, code);
  return { transport, slug: `${target.owner}/${target.repo}`, code };
}

export async function createContext(opts: { repo?: string }): Promise<Ctx> {
  const root = findRepoRoot(opts.repo ?? process.cwd());
  const repo = await loadRepoConfig(root);
  const machine = await loadMachineConfig();
  const { transport, slug } = buildTransport(root, repo);
  const publicThreads = await assertVisibility(transport, repo, slug);
  const me = (await transport.whoami()).login;
  return { root, repo, machine, transport, me, slug, publicThreads };
}

/** The responder must not use send, serve or publish. */
export function assertNotResponder(): void {
  if (process.env.HUDDLE_RESPONDER === "1") {
    throw new HuddleError("Running inside a huddle responder environment (HUDDLE_RESPONDER=1); huddle write commands are not allowed.");
  }
}
