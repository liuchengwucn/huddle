import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function huddleHome(): string {
  return process.env.HUDDLE_HOME ?? path.join(os.homedir(), ".huddle");
}

export const auditDir = (): string => path.join(huddleHome(), "log");
export const pausedFile = (): string => path.join(huddleHome(), "paused");
export const isPaused = (): boolean => existsSync(pausedFile());

/** Test only: allow one account to ask and answer itself. Asker and responder message types do not overlap, so the same account stays distinguishable. */
export const selfAskAllowed = (): boolean => process.env.HUDDLE_ALLOW_SELF_ASK === "1";

export function machineConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "huddle", "config.yml");
}
