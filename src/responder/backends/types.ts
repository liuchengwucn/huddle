import type { RunResult } from "../runner.js";

export interface BackendRun {
  sessionId: string | null;
  text: string; // the agent's final output, handed to parseAgentOutput
}

export interface Backend {
  readonly name: "claude" | "codex";
  readonly command: string[];
  /** newSessionId: a fresh UUID for a fresh run, used by backends that let the caller pick the session id. */
  argv(opts: { resumeSessionId: string | null; newSessionId?: string | null }): string[];
  /** Throws BackendError on failure. */
  parse(r: RunResult): BackendRun;
  /** The session of a fresh run that was killed before printing its result, if it can be recovered (for a wrap-up run). */
  killedSessionId(r: RunResult, newSessionId: string | null): string | null;
}

export class BackendError extends Error {}
