import { spawnSync } from "node:child_process";
import path from "node:path";
import type { MachineConfig } from "../../config.js";
import { HuddleError } from "../../errors.js";
import { claudeBackend } from "./claude.js";
import { codexBackend } from "./codex.js";
import type { Backend } from "./types.js";

const works = (cmd: string) => spawnSync(cmd, ["--version"], { timeout: 30_000, encoding: "utf8" }).status === 0;

export function selectBackend(cfg: MachineConfig): Backend {
  let name = cfg.backend;
  if (!name) {
    if (cfg.command) name = path.basename(cfg.command[0]).includes("codex") ? "codex" : "claude";
    else if (works("claude")) name = "claude";
    else if (works("codex")) name = "codex";
    else throw new HuddleError("Cannot find a claude or codex command; set backend and command in ~/.config/huddle/config.yml.");
  }
  if (name === "codex") return codexBackend(cfg);
  return claudeBackend(cfg);
}

/** Runs <command> --version and checks that the output comes from the expected CLI. */
export function versionCheck(b: Backend): { ok: boolean; output: string } {
  const r = spawnSync(b.command[0], [...b.command.slice(1), "--version"], { timeout: 60_000, encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const ok = r.status === 0 && (b.name === "claude" ? /Claude Code/.test(output) : /codex/i.test(output));
  return { ok, output: output || (r.error ? r.error.message : `exit ${r.status}`) };
}
