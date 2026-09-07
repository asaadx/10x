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
 *     `owner`/`repo` are immutable for the same class of reason — they are the project's
 *     identity, and repointing a healthy project at a different repo would orphan its open
 *     pull requests. Only `name`, `description` and `baseBranch` mutate freely.
 *
 *  3. `repoPath` is DERIVED, never supplied: `$PROJECTS_ROOT/<id>`. 10x clones the repo itself
 *     rather than borrowing a checkout the user also works in, so the base branch is never
 *     dirty, mid-rebase or on a surprise branch. A caller naming it is refused, not obeyed.
 */
import type { SQLOutputValue } from "node:sqlite";
import { db, nowIso, toProject } from "./db.ts";
import { parseRemote } from "./github.ts";
import { projectRepoPath } from "./provision.ts";
import type { Project, ProvisionState } from "./types.ts";
import { deriveProjectSlug, validateProjectSlug } from "./lifecycle.ts";

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

/**
 * Optional, and free-form: it is prose, not an identifier. The cap is generous but finite
 * because this text is handed to every agent spawned on the project, where an unbounded field
 * would quietly eat the opening prompt.
 */
function checkDescription(value: unknown): Checked {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return fail(400, "invalid_description", "description must be a string", "description");
  }
  const description = value.trim();
  if (description.length > 2000) {
    return fail(
      400,
      "invalid_description",
      "description must be 2000 characters or fewer",
      "description",
    );
  }
  return { ok: true, value: description };
}

/**
 * A project is identified by its GitHub repo, not by where that repo happens to sit on this
 * machine, so this is the only identity the caller supplies. Rejecting a non-GitHub remote here
 * rather than at Accept is the whole point: `in_review -> done` runs through one route, and that
 * route pushes a branch and opens a pull request. A project with nowhere to push would park
 * every ticket in In Review permanently and could not even be archived, so it is refused at
 * creation instead of failing at the finish line (docs/plug-and-play-projects.md).
 */
function checkRemote(value: unknown): { ok: true; owner: string; repo: string } | ProjectFailure {
  const remote = typeof value === "string" ? value.trim() : "";
  if (remote.length === 0) {
    return fail(400, "invalid_remote", "remote is required and must be a non-empty string", "remote");
  }
  try {
    const { owner, repo } = parseRemote(normalizeRemote(remote));
    return { ok: true, owner, repo };
  } catch {
    return fail(
      400,
      "invalid_remote",
      `not a GitHub repository: "${remote}". Expected https://github.com/owner/repo or ` +
        "git@github.com:owner/repo.",
      "remote",
    );
  }
}

/**
 * `parseRemote` is strict because it also parses what git hands back from `remote get-url`.
 * A human pasting from a browser brings along a trailing slash, a `/tree/main` suffix or a
 * missing scheme, none of which change which repo is meant. Normalising here keeps that
 * leniency at the edge instead of loosening the parser every consumer shares.
 */
export function normalizeRemote(raw: string): string {
  let remote = raw.replace(/\s+/g, "").replace(/\/+$/, "");
  remote = remote.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/(?:tree|blob|pull)\/.*$/, "$1");
  if (remote.startsWith("github.com/") || remote.startsWith("www.github.com/")) {
    remote = `https://${remote.replace(/^www\./, "")}`;
  }
  return remote;
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

/**
 * Takes `{ remote, name, description?, id?, baseBranch? }`. The row lands `pending`: the clone
 * is minutes of work on a large repo and the caller kicks it off separately, so this stays the
 * fast, synchronous half — parse, validate, insert, answer.
 *
 * `id` is optional because the slug is derived from the repo name. It is still accepted so the
 * dialog can offer an edited one, since the derived slug is frozen forever and lands in every
 * branch name this project ever creates.
 */
export function createProject(input: unknown): ProjectResult {
  if (typeof input !== "object" || input === null) {
    return fail(400, "invalid_body", "expected a JSON object");
  }

  const remote = checkRemote("remote" in input ? input.remote : undefined);
  if (!remote.ok) return remote;

  if ("repoPath" in input) {
    return fail(
      400,
      "immutable_field",
      "repoPath is derived from the project id and cannot be supplied — 10x clones the repo " +
        "itself. Remove the field.",
      "repoPath",
    );
  }

  const id = checkSlug("id" in input ? input.id : deriveProjectSlug(remote.repo));
  if (!id.ok) return id;
  const name = checkName("name" in input ? input.name : undefined);
  if (!name.ok) return name;
  const description = checkDescription("description" in input ? input.description : "");
  if (!description.ok) return description;
  const baseBranch = checkBaseBranch("baseBranch" in input ? input.baseBranch : "main");
  if (!baseBranch.ok) return baseBranch;

  // ON CONFLICT DO NOTHING makes the insert its own duplicate check: no read-then-write
  // window, and `changes` tells us which of the two happened.
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO projects
         (id, name, description, owner, repo, repo_path, base_branch,
          provision_state, provision_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      id.value,
      name.value,
      description.value,
      remote.owner,
      remote.repo,
      projectRepoPath(id.value),
      baseBranch.value,
      now,
      now,
    );
  if (res.changes !== 1) {
    return fail(409, "project_exists", `a project with id "${id.value}" already exists`, "id");
  }

  // Read back rather than reassembling the row by hand: the table owns the defaults for
  // provisioning state, and a second construction site here would be free to drift from them.
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

  // `repoPath` is derived and `owner`/`repo` are the project's identity. Repointing a healthy
  // project at a different repo would orphan its open pull requests, so re-linking is offered
  // only for a project that failed to provision — where there is nothing to orphan yet.
  for (const field of ["repoPath", "owner", "repo"] as const) {
    if (!(field in input)) continue;
    if ((field === "owner" || field === "repo") && existing.provisionState === "failed") continue;
    return fail(
      400,
      "immutable_field",
      field === "repoPath"
        ? "repoPath is derived from the project id and cannot be changed — 10x owns the clone."
        : `${field} is part of this project's identity and cannot be changed while it is ` +
          "usable; its open pull requests would be orphaned. Re-linking is only available for " +
          "a project that failed to provision.",
      field,
    );
  }

  const updates: Array<[column: string, value: string]> = [];
  if ("name" in input) {
    const name = checkName(input.name);
    if (!name.ok) return name;
    updates.push(["name", name.value]);
  }
  if ("description" in input) {
    const description = checkDescription(input.description);
    if (!description.ok) return description;
    updates.push(["description", description.value]);
  }
  if ("baseBranch" in input) {
    const baseBranch = checkBaseBranch(input.baseBranch);
    if (!baseBranch.ok) return baseBranch;
    updates.push(["base_branch", baseBranch.value]);
  }

  // Re-linking a failed project: accepted above, applied here, and it resets provisioning so
  // the retry starts clean rather than inheriting the old failure message.
  if (existing.provisionState === "failed" && ("owner" in input || "repo" in input)) {
    const remote = checkRemote(
      "remote" in input
        ? input.remote
        : `https://github.com/${"owner" in input ? String(input.owner) : existing.owner}/${
            "repo" in input ? String(input.repo) : existing.repo
          }`,
    );
    if (!remote.ok) return remote;
    updates.push(["owner", remote.owner], ["repo", remote.repo]);
    updates.push(["provision_state", "pending"], ["provision_error", ""]);
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
 * The only writer of `provision_state`. Kept here rather than in `provision.ts` so that module
 * stays a pure worker with no database reach: it reports what happened, and the caller records
 * it. `provision_error` is cleared on every non-failed transition so a stale message from an
 * earlier attempt can never outlive the retry that fixed it.
 */
export function setProvisionState(
  id: string,
  state: ProvisionState,
  error = "",
): Project | undefined {
  db.prepare(
    "UPDATE projects SET provision_state = ?, provision_error = ?, updated_at = ? WHERE id = ?",
  ).run(state, state === "failed" ? error : "", nowIso(), id);
  return getProject(id);
}

/**
 * Drops the project row; tickets follow via ON DELETE CASCADE.
 *
 * Deliberately NOT the whole story: agents, worktrees, branches and the clone directory are all
 * outside SQLite, and destroying them is the caller's job (memory/teardown.md). The route owns
 * that sequence because it is the only layer that can refuse the delete first — a ticket with an
 * open pull request must block it, since force-removing that branch would strand a review.
 */
export function deleteProject(id: string): { ok: boolean } {
  const res = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return { ok: res.changes === 1 };
}
