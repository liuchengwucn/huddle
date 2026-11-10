import { isSafeSessionId } from "../../core/audit.js";
import type { MachineConfig } from "../../config.js";
import type { RunResult } from "../runner.js";
import { BackendError, type Backend, type BackendRun } from "./types.js";

interface Parsed {
  sessionId: string | null;
  text: string | null;
  errors: string[];
}

/** Parses the JSONL event stream of `codex exec --json` (stdout, one event per line). */
function parseEvents(stdout: string): Parsed {
  const out: Parsed = { sessionId: null, text: null, errors: [] };
  for (const line of stdout.split("\n")) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") out.sessionId = ev.thread_id;
    const item = ev.item as { type?: string; text?: string } | undefined;
    if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") out.text = item.text;
    if (ev.type === "turn.failed" && typeof ev.error?.message === "string") out.errors.push(ev.error.message);
    else if (ev.type === "error" && typeof ev.message === "string") out.errors.push(ev.message);
  }
  return out;
}

export function codexBackend(cfg: MachineConfig): Backend {
  const command = cfg.command ?? ["codex"];
  return {
    name: "codex",
    command,
    // Verified empirically: `exec resume` does not accept --sandbox, so override with -c sandbox_mode; --json can go after resume and before the session id.
    argv: ({ resumeSessionId: rid }) => {
      const resumeSessionId = rid && isSafeSessionId(rid) ? rid : null;
      return resumeSessionId
        ? [...command, "exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', resumeSessionId, "-"]
        : [...command, "exec", "--json", "--sandbox", "danger-full-access", "-"];
    },
    parse(r: RunResult): BackendRun {
      if (r.spawnError) throw new BackendError(`Cannot start ${command[0]}: ${r.spawnError}`);
      if (r.timedOut) throw new BackendError("timed out");
      const p = parseEvents(r.stdout);
      if (r.exitCode !== 0) {
        const detail = p.errors.length ? `error events: ${p.errors.join(" | ").slice(-1000)} | ` : "";
        throw new BackendError(`exit code ${r.exitCode}: ${detail}stderr: ${r.stderr.slice(-1000)} | stdout: ${r.stdout.slice(-1000)}`);
      }
      if (p.text === null) {
        throw new BackendError(`codex output contains no agent message${p.errors.length ? `: ${p.errors.join(" | ").slice(-1000)}` : ""}`);
      }
      return { sessionId: p.sessionId, text: p.text };
    },
  };
}
