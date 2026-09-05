/**
 * Tests for `provisionSkill`: the general mechanism, not the one skill that needed it first
 * (memory/spawn.md documents the convention). Exercised against the real `skills/visual-diff`
 * source and a real git repository, the same way spawn.test.ts exercises `injectPortBlock` —
 * `excludeFromGit` resolves `info/exclude` with `git rev-parse --git-path`, which only answers
 * inside a repo.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSkill } from "./skills.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-skills-test-"));
const worktree = join(dir, "worktree");
mkdirSync(worktree);
execFileSync("git", ["init", "-q", worktree], { stdio: "ignore" });

after(() => rmSync(dir, { recursive: true, force: true }));

describe("provisionSkill", () => {
  test("copies the skill verbatim to .agents/skills/<name>/", async () => {
    await provisionSkill(worktree, "visual-diff");

    const copied = join(worktree, ".agents", "skills", "visual-diff", "SKILL.md");
    const source = join(import.meta.dirname, "..", "..", "skills", "visual-diff", "SKILL.md");
    assert.equal(await readFile(copied, "utf8"), await readFile(source, "utf8"));
  });

  test("excludes the copied directory from git, without touching a tracked .gitignore", async () => {
    const excludeFile = execFileSync(
      "git",
      ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim();

    assert.match(readFileSync(excludeFile, "utf8"), /^\.agents\/skills\/visual-diff\/$/m);
    assert.equal(existsSync(join(worktree, ".gitignore")), false);

    const status = execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
      cwd: worktree,
      encoding: "utf8",
    });
    assert.equal(status, "");
  });

  test("provisioning twice is idempotent: one exclude line, no error", async () => {
    await provisionSkill(worktree, "visual-diff");
    await provisionSkill(worktree, "visual-diff");

    const excludeFile = execFileSync(
      "git",
      ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim();
    const lines = readFileSync(excludeFile, "utf8").split("\n").filter((l) => l === ".agents/skills/visual-diff/");
    assert.equal(lines.length, 1);
  });
});
