import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

export const VERSION_RE = /<!-- huddle-skill-version: ([^ ]+) -->/;
export const SKILL_REL = path.join(".claude", "skills", "huddle", "SKILL.md");

/** Numeric x.y.z comparison; prerelease suffixes ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const normalize = (s: string) => s.replace(VERSION_RE, "").replace(/\r\n/g, "\n").trim();

/** Outdated = installed stamp is older than the CLI AND content actually differs from the bundled skill. */
export function skillOutdated(installed: string, bundled: string, cliVersion: string): boolean {
  const v = VERSION_RE.exec(installed)?.[1];
  if (!v) return false;
  return compareVersions(v, cliVersion) < 0 && normalize(installed) !== normalize(bundled);
}

/** The bundled skill template (dist/cli and src/cli are both two levels below the package root). */
export function skillTemplateSync(): string {
  return readFileSync(fileURLToPath(new URL("../../skill/SKILL.md", import.meta.url)), "utf8");
}

export function renderSkill(template: string, version = VERSION): string {
  return template.replaceAll("{{VERSION}}", version);
}

export const OUTDATED_MESSAGE =
  'huddle: the huddle skill in this repo is outdated; run "npx -y huddle-agent@latest init" to update it.';

/** Warning text when the installed project skill is outdated, else null. Never throws. */
export function outdatedSkillWarning(root: string, cliVersion = VERSION): string | null {
  try {
    const file = path.join(root, SKILL_REL);
    if (!existsSync(file)) return null;
    const bundled = renderSkill(skillTemplateSync(), cliVersion);
    return skillOutdated(readFileSync(file, "utf8"), bundled, cliVersion) ? OUTDATED_MESSAGE : null;
  } catch {
    return null;
  }
}

/** preAction decision: warning text to print, or null. Silent (no stdio) and never throws. */
export function preActionWarning(commandName: string, repoOpt: string | undefined, cwd = process.cwd(), env = process.env): string | null {
  if (commandName === "init" || env.HUDDLE_RESPONDER === "1") return null;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoOpt ?? cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return outdatedSkillWarning(root);
  } catch {
    return null;
  }
}
