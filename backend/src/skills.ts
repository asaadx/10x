/**
 * How 10x provisions a skill into a spawned agent's worktree — the general mechanism, not
 * just the one call site that needed it first. See memory/spawn.md for the convention this
 * documents and why it lives here rather than inline in runner.ts.
 *
 * Skills are prose a human edits, not code — the same reason `prompts/` sits beside `backend/`
 * and `frontend/` rather than under `src/` (see prompts.ts's header). `skills/` is that same
 * sibling, one directory per skill, each shaped exactly like `.agents/skills/<name>/` is meant
 * to be, because that IS where it lands: OMP discovers a skill from `.agents/skills/<name>/
 * SKILL.md` inside the worktree it starts in, the same way this repo's own `.agents/skills/
 * playwright-cli/` is discovered when an agent is pointed at 10x itself.
 */
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { excludeFromGit } from "./git.ts";

/** Sibling of `prompts/`, resolved the same way — see prompts.ts's header for why. */
const SKILLS_DIR = join(import.meta.dirname, "..", "..", "skills");

/**
 * Copy one of 10x's own skills into a ticket's worktree, verbatim, at the exact path OMP
 * reads a skill from. Deliberately generic: one function, keyed by name, that copies and
 * templates nothing — so choosing WHICH skills a given ticket gets (a per-playbook set, later)
 * is a decision for the call site, not for this function.
 *
 * Excluded from git exactly like the port `.env` (git.ts): this is 10x's own tooling landing
 * in the worktree, not the project's code, and it must never surface in the agent's diff or
 * the pull request it opens. The exclude entry names this exact skill's directory, so it
 * cannot blind a project that tracks its own `.agents/skills/` — this repo tracks
 * `playwright-cli` there, and provisioning a different skill name must not touch it.
 */
export async function provisionSkill(worktreePath: string, name: string): Promise<void> {
  const dest = join(worktreePath, ".agents", "skills", name);
  await cp(join(SKILLS_DIR, name), dest, { recursive: true });
  await excludeFromGit(worktreePath, `.agents/skills/${name}/`);
}
