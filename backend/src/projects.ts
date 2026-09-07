/**
 * Projects: the repo a ticket lives in, and the slug every derived identifier hangs off.
 *
 * Two things here are load-bearing, both from memory/herdr-omp-lifecycle.md memory/naming.md:
 *
 *  1. The slug is validated at CREATION time. It feeds the branch and the Herdr agent
 *     name, whose charsets disagree — `my.app` yields a legal git branch and an illegal
 *     agent name, so without this check the worktree gets created and only `agent.start`
 *     fails, leaving residue behind a confusing error.
 *
 *  2. The slug is IMMUTABLE. Branch and agent names are computed from it and existing
 *     worktrees already carry the old value, so renaming would orphan every one of them.
 *     Only `name`, `repoPath` and `baseBranch` — which nothing is derived from — mutate.
 *
 * The repo path is checked for a `.git` entry for the same reason: the alternative is
 * discovering the mistake as a `worktree_create_failed` at spawn time (memory/operations.md).
 */
import type { SQLOutputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { db, nowIso, toProject } from "./db.ts";
import type { Project } from "./types.ts";
import { validateProjectSlug } from "./lifecycle.ts";

export type ProjectError = { error: string; field?: string; message: string };

/** Failure carries the HTTP status so the route handler stays a one-liner. */
export type ProjectFailure = { ok: false; status: number; body: ProjectError };

export type ProjectResult = { ok: true; project: Project } | ProjectFailure;

type Checked = { ok: true; value: string } | ProjectFailure;

function fail(status: number, error: string, message: string, field?: string): ProjectFailure {
  const body = field === undefined ? { error, message } : { error, field, message };
  return { ok: false, status, body };
}

/**
 * Every column of `projects` is `TEXT NOT NULL`, so a non-string means the table was
 * altered underneath us. Throwing beats handing back a half-built Project that fails
 * later, far from the cause.
 */
function rowToProject(row: Record<string, SQLOutputValue>): Project {
  const {
    id,
    name,
    description,
    owner,
    repo,
    repo_path,
    base_branch,
    provision_state,
    provision_error,
    created_at,
    updated_at,
  } = row;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof repo_path !== "string" ||
    typeof base_branch !== "string" ||
    typeof provision_state !== "string" ||
    typeof provision_error !== "string" ||
    typeof created_at !== "string" ||
    typeof updated_at !== "string"
  ) {
    throw new Error(`projects row has an unexpected shape: ${JSON.stringify(row)}`);
  }
  return toProject({
    id,
    name,
    description,
    owner,
    repo,
    repo_path,
    base_branch,
    provision_state,
    provision_error,
    created_at,
    updated_at,
  });
}

function checkSlug(value: unknown): Checked {
  if (typeof value !== "string" || value.length === 0) {
    return fail(400, "invalid_project_slug", "id is required and must be a string", "id");
  }
  const verdict = validateProjectSlug(value);
  if (!verdict.ok) return fail(400, "invalid_project_slug", verdict.message, "id");
  return { ok: true, value };
}

function checkName(value: unknown): Checked {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0) {
    return fail(400, "invalid_name", "name is required and must be a non-empty string", "name");
  }
  return { ok: true, value: name };
}

function checkRepoPath(value: unknown): Checked {
  const bad = (message: string) => fail(400, "invalid_repo_path", message, "repoPath");
  const path = typeof value === "string" ? value.trim() : "";
  if (path.length === 0) return bad("repoPath is required and must be a non-empty string");
  // Herdr's socket API takes paths verbatim; only its CLI expands relative ones (memory/socket.md).
  if (!isAbsolute(path)) return bad(`repoPath must be an absolute path, got "${path}"`);
  if (!existsSync(path)) return bad(`repoPath does not exist: ${path}`);
  if (!existsSync(join(path, ".git"))) {
    return bad(`repoPath is not a git repository (no .git entry): ${path}`);
  }
  return { ok: true, value: path };
}

/** Handed to git verbatim as `worktree.create`'s `base`, so keep it ref-shaped. */
const BASE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function checkBaseBranch(value: unknown): Checked {
  const branch = typeof value === "string" ? value.trim() : "";
  if (!BASE_BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    return fail(
      400,
      "invalid_base_branch",
      "baseBranch must be a git ref name: start with a letter or digit and contain only " +
        "A-Z, a-z, 0-9, '.', '_', '-' or '/'",
      "baseBranch",
    );
  }
  return { ok: true, value: branch };
}

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at, id").all().map(rowToProject);
}

export function getProject(id: string): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row === undefined ? undefined : rowToProject(row);
}

export function createProject(input: unknown): ProjectResult {
  if (typeof input !== "object" || input === null) {
    return fail(400, "invalid_body", "expected a JSON object");
  }

  const id = checkSlug("id" in input ? input.id : undefined);
  if (!id.ok) return id;
  const name = checkName("name" in input ? input.name : undefined);
  if (!name.ok) return name;
  const repoPath = checkRepoPath("repoPath" in input ? input.repoPath : undefined);
  if (!repoPath.ok) return repoPath;
  const baseBranch = checkBaseBranch("baseBranch" in input ? input.baseBranch : "main");
  if (!baseBranch.ok) return baseBranch;

  // ON CONFLICT DO NOTHING makes the insert its own duplicate check: no read-then-write
  // window, and `changes` tells us which of the two happened.
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(id.value, name.value, repoPath.value, baseBranch.value, now, now);
  if (res.changes !== 1) {
    return fail(409, "project_exists", `a project with id "${id.value}" already exists`, "id");
  }

  // Read back rather than reassembling the row by hand: the table owns the defaults for
  // description, owner, repo and provisioning state, and a second construction site here
  // would be free to drift from them.
  const project = getProject(id.value);
  if (project === undefined) {
    throw new Error(`project "${id.value}" vanished immediately after being inserted`);
  }
  return { ok: true, project };
}

export function updateProject(id: string, input: unknown): ProjectResult {
  const existing = getProject(id);
  if (existing === undefined) {
    return fail(404, "project_not_found", `no project with id "${id}"`, "id");
  }
  if (typeof input !== "object" || input === null) {
    return fail(400, "invalid_body", "expected a JSON object");
  }

  // Echoing the unchanged id back is normal for a whole-object edit; changing it is not.
  if ("id" in input && input.id !== id) {
    return fail(
      400,
      "project_id_immutable",
      "a project id feeds its branch and agent names and cannot be changed — existing " +
        "worktrees would be orphaned. Create a new project instead.",
      "id",
    );
  }

  const updates: Array<[column: string, value: string]> = [];
  if ("name" in input) {
    const name = checkName(input.name);
    if (!name.ok) return name;
    updates.push(["name", name.value]);
  }
  if ("repoPath" in input) {
    const repoPath = checkRepoPath(input.repoPath);
    if (!repoPath.ok) return repoPath;
    updates.push(["repo_path", repoPath.value]);
  }
  if ("baseBranch" in input) {
    const baseBranch = checkBaseBranch(input.baseBranch);
    if (!baseBranch.ok) return baseBranch;
    updates.push(["base_branch", baseBranch.value]);
  }
  if (updates.length === 0) return { ok: true, project: existing };

  const now = nowIso();
  const assignments = updates.map(([column]) => `${column} = ?`).join(", ");
  db.prepare(`UPDATE projects SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...updates.map(([, value]) => value),
    now,
    id,
  );

  const updated = getProject(id);
  if (updated === undefined) throw new Error(`project "${id}" vanished mid-update`);
  return { ok: true, project: updated };
}

/**
 * Tickets go with it via ON DELETE CASCADE. Worktrees deliberately do NOT: removal is
 * always an explicit user action (memory/teardown.md), so tearing them down here would destroy work
 * nobody asked to lose. The caller deals with the leftovers.
 */
export function deleteProject(id: string): { ok: boolean } {
  const res = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return { ok: res.changes === 1 };
}
