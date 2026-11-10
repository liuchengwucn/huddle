import { spawnSync } from "node:child_process";
import type { Meta } from "../core/types.js";

export type Staleness = "fresh" | "stale" | "unknown";

export const STALENESS_LABEL: Record<Staleness, string> = { fresh: "fresh", stale: "possibly stale", unknown: "unknown" };

export function staleness(meta: Meta | null, repoDir: string, thresholdLines: number): Staleness {
  if (!meta?.commit || !meta.files?.length) return "unknown";
  if (!/^[0-9a-f]{7,40}$/i.test(meta.commit)) return "unknown"; // keep a commit from the metadata from being parsed as a git option
  const git = (args: string[]) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  if (git(["cat-file", "-e", `${meta.commit}^{commit}`]).status !== 0) return "unknown";
  const range = `${meta.commit}..HEAD`;
  const ns = git(["diff", "--name-status", range, "--", ...meta.files]);
  if (ns.status !== 0) return "unknown";
  if (ns.stdout.split("\n").some((l) => l.startsWith("D\t"))) return "stale";
  const num = git(["diff", "--numstat", range, "--", ...meta.files]);
  if (num.status !== 0) return "unknown";
  let total = 0;
  for (const line of num.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") return "stale"; // binary file changed
    total += Number(added) + Number(deleted);
  }
  return total > thresholdLines ? "stale" : "fresh";
}
