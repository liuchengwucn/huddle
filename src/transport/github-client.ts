import { execFileSync } from "node:child_process";
import { HuddleError } from "../errors.js";

const API = "https://api.github.com";
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 15 * 60_000;

export interface GitHubClientOptions {
  token?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const NO_TOKEN = 'No GitHub token: set GH_TOKEN (or GITHUB_TOKEN), or install the GitHub CLI and run "gh auth login".';

export function envToken(): string | undefined {
  return process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
}

export function ghToken(): string {
  const fromEnv = envToken();
  if (fromEnv) return fromEnv;
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new HuddleError(NO_TOKEN);
  }
  if (!token) throw new HuddleError(NO_TOKEN);
  return token;
}

export class GitHubClient {
  private token: string | null = null;
  private readonly tokenFn: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GitHubClientOptions = {}) {
    this.tokenFn = opts.token ?? ghToken;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private getToken(): string {
    if (!this.token) this.token = this.tokenFn();
    return this.token;
  }

  /** Queries retry on 5xx/network errors; mutations retry only when rate-limited, to avoid duplicate writes. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const retryServerErrors = !/^\s*mutation\b/.test(query);
    const res = await this.request("POST", `${API}/graphql`, { query, variables }, false, retryServerErrors);
    const json = (await res.json()) as { data?: T | null; errors?: { message: string; type?: string }[] };
    // Queries: for a missing object GitHub returns null in data plus a NOT_FOUND error; leave the null check to the caller. A NOT_FOUND from a mutation must throw.
    if (json.errors?.length && (!retryServerErrors || !json.errors.every((e) => e.type === "NOT_FOUND"))) {
      throw new HuddleError(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data as T;
  }

  /** Returns the status code and JSON (also for non-2xx; the caller decides). */
  async rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.request(method, `${API}${path}`, body, true, method.toUpperCase() === "GET");
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  private async request(method: string, url: string, body: unknown, allowClientErrors: boolean, retryServerErrors: boolean): Promise<Response> {
    const token = this.getToken(); // Auth failures throw immediately, no retry
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let err: unknown = null;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "huddle-agent",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        err = e;
      }
      if (res) {
        const waitMs = rateLimitWait(res);
        if (waitMs !== null) {
          if (attempt >= MAX_RETRIES) throw new HuddleError("GitHub API rate limit hit; try again later.");
          await this.sleep(waitMs);
          continue;
        }
        if (res.status < 500) {
          if (res.ok || allowClientErrors) return res;
          throw new HuddleError(`GitHub API ${method} ${url} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
        }
      }
      if (!retryServerErrors || attempt >= MAX_RETRIES) {
        throw new HuddleError(`GitHub API ${method} ${url} failed: ${err ? String(err) : `HTTP ${res?.status}`}`);
      }
      await this.sleep(1000 * 2 ** attempt);
    }
  }
}

/** When rate-limited, returns the milliseconds to wait (capped at 15 minutes); otherwise null. */
function rateLimitWait(res: Response): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.headers.get("retry-after") && Number.isFinite(retryAfter)) return Math.min(Math.max(retryAfter * 1000, 0), MAX_WAIT_MS);
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    if (Number.isFinite(reset)) return Math.min(Math.max(reset - Date.now(), 1000), MAX_WAIT_MS);
    return 60_000;
  }
  // Retry-After present but unparseable: treat as rate-limited, wait 60 seconds by default
  if (res.headers.get("retry-after")) return 60_000;
  return null;
}
