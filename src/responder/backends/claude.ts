import { isSafeSessionId } from "../../core/audit.js";
import type { MachineConfig } from "../../config.js";
import { OUTPUT_SCHEMA } from "../output.js";
import type { RunResult } from "../runner.js";
import { BackendError, type Backend, type BackendRun } from "./types.js";

/** A wrapper script may print other output before the JSON, so try the whole text first, then search from the last line backwards. */
function findResultJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  const tries = [t, ...t.split("\n").reverse(), ...(s >= 0 && e > s ? [t.slice(s, e + 1)] : [])];
  for (const c of tries) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object" && !Array.isArray(o) && ("result" in o || "session_id" in o)) return o;
    } catch {
      // continue
    }
  }
  return null;
}

const resultText = (o: Record<string, unknown>): string =>
  o.result == null ? "" : typeof o.result === "string" ? o.result : JSON.stringify(o.result);

export function claudeBackend(cfg: MachineConfig): Backend {
  const command = cfg.command ?? ["claude"];
  return {
    name: "claude",
    command,
    argv: ({ resumeSessionId }) => [
      ...command,
      "-p",
      "--permission-mode", cfg.permission_mode,
      "--output-format", "json",
      "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
      "--settings", JSON.stringify({ autoMemoryEnabled: false }),
      ...(resumeSessionId && isSafeSessionId(resumeSessionId) ? ["--resume", resumeSessionId] : []),
    ],
    parse(r: RunResult): BackendRun {
      if (r.spawnError) throw new BackendError(`Cannot start ${command[0]}: ${r.spawnError}`);
      if (r.timedOut) throw new BackendError("timed out");
      const o = findResultJson(r.stdout);
      if (r.exitCode !== 0) {
        if (o) throw new BackendError(`exit code ${r.exitCode}: ${resultText(o) || String(o.subtype ?? "")}`);
        throw new BackendError(`exit code ${r.exitCode}: stderr: ${r.stderr.slice(-1000)} | stdout: ${r.stdout.slice(-1000)}`);
      }
      if (!o) throw new BackendError("claude output contains no result JSON");
      if (o.is_error === true) throw new BackendError(`claude reported an error: ${resultText(o) || String(o.subtype)}`);
      const structured = o.structured_output;
      const text = structured !== undefined && structured !== null ? JSON.stringify(structured) : resultText(o);
      return { sessionId: typeof o.session_id === "string" ? o.session_id : null, text };
    },
  };
}
