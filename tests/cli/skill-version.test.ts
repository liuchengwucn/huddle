import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OUTDATED_MESSAGE, SKILL_RELS, preActionWarning, compareVersions, outdatedSkillWarning, renderSkill, skillOutdated, skillTemplateSync } from "../../src/cli/skill-version.js";

const stamp = (v: string, body = "body") => `---\nname: huddle\n---\n<!-- huddle-skill-version: ${v} -->\n${body}\n`;

describe("compareVersions", () => {
  it("compares numerically and ignores prerelease", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });
});

describe("skillOutdated", () => {
  it("is true only when older and different", () => {
    expect(skillOutdated(stamp("0.1.0", "old"), stamp("0.2.0", "new"), "0.2.0")).toBe(true);
    expect(skillOutdated(stamp("0.1.0"), stamp("0.2.0"), "0.2.0")).toBe(false);
    expect(skillOutdated(stamp("0.3.0", "old"), stamp("0.2.0", "new"), "0.2.0")).toBe(false);
    expect(skillOutdated(stamp("0.2.0", "old"), stamp("0.2.0", "new"), "0.2.0")).toBe(false);
    expect(skillOutdated("no stamp here", stamp("0.2.0"), "0.2.0")).toBe(false);
  });
});

describe("outdatedSkillWarning", () => {
  it("warns for an old differing skill, not for missing or current", () => {
    const root = mkdtempSync(path.join(tmpdir(), "huddle-sv-"));
    expect(outdatedSkillWarning(root, "9.9.9")).toBeNull();
    const file = path.join(root, SKILL_RELS[0]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, stamp("0.0.1", "ancient"));
    expect(outdatedSkillWarning(root, "9.9.9")).toBe(OUTDATED_MESSAGE);
    writeFileSync(file, renderSkill(skillTemplateSync(), "9.9.9"));
    expect(outdatedSkillWarning(root, "9.9.9")).toBeNull();
    writeFileSync(file, renderSkill(skillTemplateSync(), "0.0.1"));
    expect(outdatedSkillWarning(root, "9.9.9")).toBeNull();
  });

  it("checks the .agents/skills copy too", () => {
    const root = mkdtempSync(path.join(tmpdir(), "huddle-sv-"));
    for (const rel of SKILL_RELS) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), renderSkill(skillTemplateSync(), "9.9.9"));
    }
    expect(outdatedSkillWarning(root, "9.9.9")).toBeNull();
    writeFileSync(path.join(root, SKILL_RELS[1]), stamp("0.0.1", "ancient"));
    expect(outdatedSkillWarning(root, "9.9.9")).toBe(OUTDATED_MESSAGE);
  });
});

describe("preActionWarning", () => {
  it("skips init and responder, and is silent outside a git repo", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "huddle-pa-"));
    const spy = vi.spyOn(process.stderr, "write");
    try {
      expect(preActionWarning("ask", dir)).toBeNull();
      expect(preActionWarning("init", dir)).toBeNull();
      expect(preActionWarning("ask", dir, dir, { HUDDLE_RESPONDER: "1" })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
