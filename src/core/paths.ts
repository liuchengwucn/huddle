import os from "node:os";
import path from "node:path";

export function huddleHome(): string {
  return process.env.HUDDLE_HOME ?? path.join(os.homedir(), ".huddle");
}

export const auditDir = (): string => path.join(huddleHome(), "log");

/** Test only: allow one account to send to and reply to itself. Sender and responder message types do not overlap, so the same account stays distinguishable. */
export const selfSendAllowed = (): boolean => process.env.HUDDLE_ALLOW_SELF_SEND === "1";

export function machineConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "huddle", "config.yml");
}
