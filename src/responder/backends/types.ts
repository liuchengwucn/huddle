import type { RunResult } from "../runner.js";

export interface BackendRun {
  sessionId: string | null;
  text: string; // the agent's final output, handed to parseAgentOutput
}

export interface Backend {
  readonly name: "claude" | "codex";
  readonly command: string[];
  argv(opts: { resumeSessionId: string | null }): string[];
  /** Throws BackendError on failure. */
  parse(r: RunResult): BackendRun;
}

export class BackendError extends Error {}
