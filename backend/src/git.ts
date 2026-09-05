/**
 * Keep 10x's own writes inside a ticket worktree invisible to `git status`, without touching
 * the project's tracked `.gitignore` — that file belongs to the project, not to us.
 *
 * `rev-parse --git-path`, never `join(worktreePath, ".git", …)`. In a linked worktree `.git`
 * is a FILE, and git resolves `info/exclude` against the COMMON git directory — the source
 * repo's `.git/info/exclude`, shared by every ticket worktree of that repo. Verified (see
 * runner.ts's original comment, before this was extracted): after appending an entry there,
 * `git status` inside the worktree is clean and `git check-ignore` names that file. Being
 * shared is exactly why the append below is conditional on the entry not already being there.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Add `entry` to this worktree's shared `info/exclude`, idempotently. `entry` is whatever a
 * `.gitignore` line would be — a bare filename, or a directory with a trailing `/`.
 */
export async function excludeFromGit(worktreePath: string, entry: string): Promise<void> {
  const resolved = await run("git", [
    "-C",
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const excludeFile = resolved.stdout.trim();
  // Absent on a repo cloned without the template, so create the directory rather than assume.
  await mkdir(dirname(excludeFile), { recursive: true });
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  if (current.split("\n").includes(entry)) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(excludeFile, `${current}${separator}${entry}\n`, "utf8");
}

/**
 * Does the project's own history already track something at `relPath` (relative to the
 * worktree root)? `git ls-files` reads the index, which for a freshly created worktree
 * matches HEAD exactly — so this answers "does the base branch already commit this path",
 * not "does a file exist there right now" (an untracked file on disk would not count).
 */
export async function isTracked(worktreePath: string, relPath: string): Promise<boolean> {
  const { stdout } = await run("git", ["-C", worktreePath, "ls-files", "--", relPath]);
  return stdout.trim() !== "";
}
