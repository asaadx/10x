/**
 * Projects: the repo a ticket lives in, and the slug every derived identifier hangs off.
 *
 * Three things here are load-bearing (memory/naming.md):
 *
 *  1. The slug is validated at CREATION time (lifecycle.ts `PROJECT_SLUG_RE`). It is the first
 *     half of every ticket id, which ends up in branch names, directory names and SQL an agent
 *     types by hand, so a bad one must be refused before anything is built on it.
 *
 *  2. The slug is IMMUTABLE. Ticket ids are computed from it and every existing ticket, branch
 *     and pull request already carries the old value, so renaming would orphan all of them.
 *     `owner`/`repo` are immutable for the same class of reason — they are the project's
 *     identity, and repointing a healthy project at a different repo would orphan its open
 *     pull requests. Only `name`, `description`, `baseBranch` and `devCommand` mutate freely.
 *
 *  3. `repoPath` is DERIVED, never supplied: `$PROJECTS_ROOT/<id>`. 10x clones the repo itself
 *     rather than borrowing a checkout the user also works in, so the base branch is never
 *     dirty, mid-rebase or on a surprise branch. A caller naming it is refused, not obeyed.
 */
import { db, nowIso, toProject } from "./db.ts";
import type { Row } from "./sql.ts";
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
function rowToProject(row: Row): Project {
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
    dev_command,
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
    typeof dev_command !== "string" ||
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
    dev_command,
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
 * only so a runaway paste cannot bloat every board read that carries the project list.
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

/**
 * Free-form shell, run by Preview with `sh -c` in a checkout of the ticket's branch — so it is
 * whatever the user would type there (`pnpm dev`, `npm run dev -- --port $PORT`). Only this
 * user sets it, for their own machine, so there is nothing to validate beyond shape; the cap
 * is the same runaway-paste guard `description` has. '' clears it.
 */
function checkDevCommand(value: unknown): Checked {
  if (value === null) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return fail(400, "invalid_dev_command", "devCommand must be a string", "devCommand");
  }
  const command = value.trim();
  if (command.length > 1000 || command.includes("\n")) {
    return fail(
      400,
      "invalid_dev_command",
      "devCommand must be one line of 1000 characters or fewer",
      "devCommand",
    );
  }
  return { ok: true, value: command };
}

export async function listProjects(): Promise<Project[]> {
  const { rows } = await db.execute("SELECT * FROM projects ORDER BY created_at, id");
  return rows.map(rowToProject);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const { rows } = await db.execute("SELECT * FROM projects WHERE id = ?", [id]);
  const row = rows[0];
  return row === undefined ? undefined : rowToProject(row);
}

/**
 * Takes `{ remote, name, description?, id?, baseBranch?, devCommand? }`. The row lands `pending`: the clone
 * is minutes of work on a large repo and the caller kicks it off separately, so this stays the
 * fast, synchronous half — parse, validate, insert, answer.
 *
 * `id` is optional because the slug is derived from the repo name. It is still accepted so the
 * dialog can offer an edited one, since the derived slug is frozen forever and lands in every
 * branch name this project ever creates.
 */
export async function createProject(input: unknown): Promise<ProjectResult> {
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
  // Accepted at creation too, so the dialog can set it in one request rather than a create
  // followed by a PATCH that could fail after the project already exists.
  const devCommand = checkDevCommand("devCommand" in input ? input.devCommand : "");
  if (!devCommand.ok) return devCommand;

  // ON CONFLICT DO NOTHING makes the insert its own duplicate check: no read-then-write
  // window, and `rowsAffected` tells us which of the two happened.
  const now = nowIso();
  const res = await db.execute(
    `INSERT INTO projects
       (id, name, description, owner, repo, repo_path, base_branch,
        provision_state, provision_error, dev_command, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [
      id.value,
      name.value,
      description.value,
      remote.owner,
      remote.repo,
      projectRepoPath(id.value),
      baseBranch.value,
      devCommand.value,
      now,
      now,
    ],
  );
  if (res.rowsAffected !== 1) {
    return fail(409, "project_exists", `a project with id "${id.value}" already exists`, "id");
  }

  // Read back rather than reassembling the row by hand: the table owns the defaults for
  // provisioning state, and a second construction site here would be free to drift from them.
  const project = await getProject(id.value);
  if (project === undefined) {
    throw new Error(`project "${id.value}" vanished immediately after being inserted`);
  }
  return { ok: true, project };
}

export async function updateProject(id: string, input: unknown): Promise<ProjectResult> {
  const existing = await getProject(id);
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
  if ("devCommand" in input) {
    const devCommand = checkDevCommand(input.devCommand);
    if (!devCommand.ok) return devCommand;
    updates.push(["dev_command", devCommand.value]);
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
  await db.execute(`UPDATE projects SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...updates.map(([, value]) => value),
    now,
    id,
  ]);

  const updated = await getProject(id);
  if (updated === undefined) throw new Error(`project "${id}" vanished mid-update`);
  return { ok: true, project: updated };
}

/**
 * The only writer of `provision_state`. Kept here rather than in `provision.ts` so that module
 * stays a pure worker with no database reach: it reports what happened, and the caller records
 * it. `provision_error` is cleared on every non-failed transition so a stale message from an
 * earlier attempt can never outlive the retry that fixed it.
 */
export async function setProvisionState(
  id: string,
  state: ProvisionState,
  error = "",
): Promise<Project | undefined> {
  await db.execute(
    "UPDATE projects SET provision_state = ?, provision_error = ?, updated_at = ? WHERE id = ?",
    [state, state === "failed" ? error : "", nowIso(), id],
  );
  return getProject(id);
}

/**
 * Drops the project row and its tickets, in one batch.
 *
 * The tickets are deleted explicitly rather than left to ON DELETE CASCADE: foreign keys are
 * a per-connection PRAGMA, and against Turso every request is its own stream with no
 * connection to have set it on. Deleting children first works whether or not the cascade
 * would have fired, and the batch keeps "project gone, tickets left" from ever being visible.
 *
 * Deliberately NOT the whole story: agents, worktrees, branches and the clone directory are all
 * outside SQLite, and destroying them is the caller's job (memory/teardown.md). The route owns
 * that sequence because it is the only layer that can refuse the delete first — a ticket with an
 * open pull request must block it, since force-removing that branch would strand a review.
 */
export async function deleteProject(id: string): Promise<{ ok: boolean }> {
  const [, res] = await db.batch([
    { sql: "DELETE FROM tickets WHERE project_id = ?", args: [id] },
    { sql: "DELETE FROM projects WHERE id = ?", args: [id] },
  ]);
  return { ok: res?.rowsAffected === 1 };
}
