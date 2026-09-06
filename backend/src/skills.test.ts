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
import { readFile, writeFile } from "node:fs/promises";
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

  test("never overwrites a skill the target repo already tracks under that name", async () => {
    const tracked = join(dir, "tracked-worktree");
    mkdirSync(tracked);
    execFileSync("git", ["init", "-q", tracked], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tracked });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tracked });
    const trackedSkillDir = join(tracked, ".agents", "skills", "visual-diff");
    mkdirSync(trackedSkillDir, { recursive: true });
    const projectsOwnContent = "# The project's own visual-diff skill, not 10x's.\n";
    await writeFile(join(trackedSkillDir, "SKILL.md"), projectsOwnContent, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: tracked });
    execFileSync("git", ["commit", "-q", "-m", "commit our own visual-diff skill"], { cwd: tracked });

    await provisionSkill(tracked, "visual-diff");

    // Untouched: still the project's content, not 10x's.
    assert.equal(await readFile(join(trackedSkillDir, "SKILL.md"), "utf8"), projectsOwnContent);
    // No exclude entry either — this was never 10x's file to hide.
    const excludeFile = execFileSync(
      "git",
      ["-C", tracked, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim();
    const excludeContent = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    assert.ok(!excludeContent.includes(".agents/skills/visual-diff/"));
  });
});

describe("provisionSkill (ticket-api)", () => {
  test("copies the skill verbatim to .agents/skills/ticket-api/", async () => {
    await provisionSkill(worktree, "ticket-api");

    const copied = join(worktree, ".agents", "skills", "ticket-api", "SKILL.md");
    const source = join(import.meta.dirname, "..", "..", "skills", "ticket-api", "SKILL.md");
    assert.equal(await readFile(copied, "utf8"), await readFile(source, "utf8"));
  });

  test("excludes the copied directory from git, alongside visual-diff's own entry", async () => {
    const excludeFile = execFileSync(
      "git",
      ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim();

    assert.match(readFileSync(excludeFile, "utf8"), /^\.agents\/skills\/ticket-api\/$/m);

    const status = execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
      cwd: worktree,
      encoding: "utf8",
    });
    assert.equal(status, "");
  });
});
