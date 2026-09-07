/**
 * SQLite store. Zero dependencies — `node:sqlite` is built into Node 24.
 *
 * Two design rules, both from memory/herdr-omp-lifecycle.md:
 *
 *  1. Store what WE own, never what Herdr owns (memory/naming.md). `branch` and `agent_name` are
 *     values we choose and hand to Herdr, so they are persisted: if their format ever
 *     changes, existing tickets keep pointing at the branch that actually exists.
 *     Worktree paths, pane ids and workspace ids are Herdr's and are never stored —
 *     they are read live on every request.
 *
 *  2. Status is the lock (memory/operations.md). `claimTicket` is a conditional UPDATE and reports whether
 *     it won, so a double-click cannot start two spawns.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseRemote } from "./github.ts";
import { allocateSlot, type SlotAllocation } from "./ports.ts";
import {
  PLAYBOOKS,
  type Attachment,
  type ChecklistItem,
  type Playbook,
  type Priority,
  type Project,
  type ProvisionState,
  type PullRequestState,
  type ScreenshotSide,
  type Status,
  type Ticket,
} from "./types.ts";

export const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), ".10x");
const DB_PATH = process.env.DB_PATH ?? join(STATE_DIR, "10x.db");

/**
 * Where 10x keeps its own clone of each project. Its own, deliberately: borrowing a checkout
 * the user also works in would mean agents branching off a dirty tree, a surprise branch, or a
 * half-finished rebase. A project's `repo_path` is always `$PROJECTS_ROOT/<id>`.
 */
export const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? join(STATE_DIR, "repos");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- The project's real identity. repo_path is only where this repo is materialised on this
  -- machine; owner/repo is what every push and pull request targets, and it is read from a
  -- column rather than re-derived by shelling "git remote get-url origin" on every call.
  owner       TEXT NOT NULL DEFAULT '',
  repo        TEXT NOT NULL DEFAULT '',
  -- Derived, never user-supplied: $PROJECTS_ROOT/<id>.
  repo_path   TEXT NOT NULL,
  -- The bare upstream branch name. Worktree creation prefixes it with "origin/" at the call
  -- site (memory/gotchas.md G7); a pull request needs the unprefixed name as its base.
  base_branch TEXT NOT NULL DEFAULT 'main',
  provision_state TEXT NOT NULL DEFAULT 'ready',
  provision_error TEXT NOT NULL DEFAULT '',
  -- Monotonic ticket counter. NEVER derive the next number from MAX(number): deleting the
  -- highest ticket would hand its number to the next one, and since deleting a ticket does
  -- not remove its worktree (memory/teardown.md), the new ticket's branch would collide with the orphan
  -- left behind — silently adopting another ticket's work.
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'backlog',
  finished    INTEGER NOT NULL DEFAULT 0,
  died        INTEGER NOT NULL DEFAULT 0,
  branch      TEXT,
  agent_name  TEXT,
  session_dir TEXT,
  -- Which block of TCP ports this ticket's agent owns, as a slot index into the pool in
  -- ports.ts. Nullable: a ticket holds one from spawn until it leaves review. Persisted because
  -- a restart that forgot the held slots would hand one slot to two tickets.
  --
  -- The uniqueness (a UNIQUE INDEX, created below) IS the safety: SQLite makes
  -- double-assignment impossible, the same way the conditional UPDATE in claimTicket
  -- makes a double spawn impossible. NULLs are distinct in SQLite, so any number of
  -- tickets may hold no slot at all.
  port_slot   INTEGER,
  -- Set together once Accept opens the pull request. Nullable: most tickets never reach
  -- "done", and the pair is written by exactly one function, setPullRequest.
  pr_number   INTEGER,
  pr_url      TEXT,
  -- Written by the webhook receiver from the pull_request payload. additions/deletions
  -- need no API call: both are already on the event (see memory/github.md).
  pr_state     TEXT,
  pr_additions INTEGER,
  pr_deletions INTEGER,
  -- The ticket's dispatch profile, one of the values in the Playbook union. NOT NULL with a
  -- default rather than nullable: every ticket is dispatched with some profile, the picker
  -- offers no "none", and 'Fullstack' is the option it shows first — so a row's data agrees
  -- with what the board renders for it instead of a null that reads as Fullstack anyway.
  playbook    TEXT NOT NULL DEFAULT 'Fullstack',
  -- How urgently the ticket should be worked, one of the values in the Priority union. NOT
  -- NULL with a 'low' default: a ticket that predates this column, or one created without
  -- ever naming a priority (the picker offers no create-time control — see types.ts), reads
  -- as the lowest star count rather than a null the board would have to special-case.
  priority    TEXT NOT NULL DEFAULT 'low',
  -- The plan a ticket carries: its task breakdown, its acceptance criteria, and the files
  -- attached to it. JSON text rather than child tables because all three are only ever read
  -- and written whole with their ticket — there is no query that wants one item, and no join
  -- that wants them separately — and the UI computes its own ticked/total counts from the
  -- decoded array, so a COUNT(*) would buy nothing. The '[]' defaults are what keep a row
  -- from ever decoding to null; the arrays are empty, never absent.
  task_breakdown      TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  attachments         TEXT NOT NULL DEFAULT '[]',
  -- Two columns rather than one JSON blob: the pair is fixed at two, and each side is
  -- independently nullable — the "after" shot only exists once the run is over, so a ticket
  -- sits with a before and no after for its whole run. Paths, not URLs; the server maps them.
  screenshot_before TEXT,
  screenshot_after  TEXT,
  -- When the AGENT began work, which is not created_at: a ticket can sit in backlog for days
  -- before anything spawns. Null on a ticket that has never been spawned, and it is what the
  -- card's run timer counts from — counting from created_at would show that backlog wait.
  started_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE INDEX IF NOT EXISTS tickets_by_project ON tickets (project_id, status);
`;

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(SCHEMA);

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an existing database untouched, so a column added
 * after the first release has to be migrated in. Table and column names are literals from
 * this file, never input. Idempotent, and `PRAGMA table_info` is a memory read.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row["name"] === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// A UNIQUE column constraint is impossible here: SQLite's ADD COLUMN rejects one. A unique
// INDEX is the same thing by another name, and it is what a column constraint compiles to.
addColumnIfMissing("tickets", "port_slot", "INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tickets_port_slot ON tickets (port_slot)");

addColumnIfMissing("tickets", "pr_number", "INTEGER");
addColumnIfMissing("tickets", "pr_url", "TEXT");
addColumnIfMissing("tickets", "pr_state", "TEXT");
addColumnIfMissing("tickets", "pr_additions", "INTEGER");
addColumnIfMissing("tickets", "pr_deletions", "INTEGER");

// ADD COLUMN accepts NOT NULL only alongside a non-null constant default, which '[]' and
// 'Fullstack' both are — and SQLite hands that default back for every row that predates the
// column, so a migrated row reads as an empty list, or as the default playbook, never as NULL.
addColumnIfMissing("tickets", "playbook", "TEXT NOT NULL DEFAULT 'Fullstack'");
addColumnIfMissing("tickets", "task_breakdown", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tickets", "acceptance_criteria", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tickets", "attachments", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tickets", "screenshot_before", "TEXT");
addColumnIfMissing("tickets", "screenshot_after", "TEXT");
addColumnIfMissing("tickets", "started_at", "TEXT");
addColumnIfMissing("tickets", "archived", "INTEGER NOT NULL DEFAULT 0");

// Every pre-existing row backfills to 'low' on the same migration, no manual step: ADD
// COLUMN with a NOT NULL constant default hands that default back for every row that
// predates the column, exactly as the playbook and checklist columns above do.
addColumnIfMissing("tickets", "priority", "TEXT NOT NULL DEFAULT 'low'");

// A database migrated while `playbook` was briefly nullable already has the column, so
// `addColumnIfMissing` above will not revisit it and its NOT NULL default never applies to
// those rows. One idempotent backfill covers them: without it, every such row's decode hits
// a NULL in a column typed `Playbook` and throws.
db.exec("UPDATE tickets SET playbook = 'Fullstack' WHERE playbook IS NULL");

// And a database written while this branch stored lowercase slugs ('fullstack', 'devops')
// holds values the union no longer contains. Lowercasing a name yields exactly the slug it
// replaced, so the remap is derived from `PLAYBOOKS` itself rather than hand-listed — there
// is no second list to fall behind the first. Idempotent: a row already holding the exact
// name matches itself and is rewritten to the same value.
const remapPlaybook = db.prepare(
  "UPDATE tickets SET playbook = ? WHERE lower(playbook) = lower(?)",
);
for (const playbook of PLAYBOOKS) remapPlaybook.run(playbook, playbook);

// Projects gain the same treatment. 'ready' is the deliberate default for `provision_state`:
// every project that predates this column was cloned by hand and is already usable, so the
// migration must not park working projects in a provisioning state.
addColumnIfMissing("projects", "description", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("projects", "owner", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("projects", "repo", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("projects", "provision_state", "TEXT NOT NULL DEFAULT 'ready'");
addColumnIfMissing("projects", "provision_error", "TEXT NOT NULL DEFAULT ''");

// A project's GitHub identity used to be re-derived from disk on every push and pull request.
// Backfilling it needs the one thing a migration cannot do inline — read a git remote — so
// this runs once, here, and is idempotent: only rows still holding the empty default are
// touched, and a row that cannot be resolved is marked `failed` rather than left silently
// blank, because a project with no GitHub remote can never reach Done (docs/plug-and-play-projects.md).
function backfillProjectIdentity(): void {
  const rows = db.prepare("SELECT id, repo_path FROM projects WHERE owner = '' OR repo = ''").all() as {
    id: string;
    repo_path: string;
  }[];
  if (rows.length === 0) return;

  const resolved = db.prepare("UPDATE projects SET owner = ?, repo = ? WHERE id = ?");
  const unresolved = db.prepare(
    "UPDATE projects SET provision_state = 'failed', provision_error = ? WHERE id = ?",
  );

  for (const row of rows) {
    // Synchronous on purpose: this is module-init code, and every consumer of `db` expects a
    // fully migrated database the moment the import resolves. A missing folder, a directory
    // that is not a repo, a repo with no `origin`, and a non-GitHub `origin` all land in the
    // same bucket — unresolvable — so one catch covers the lot.
    let parsed: { owner: string; repo: string } | null = null;
    try {
      const url = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: row.repo_path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      parsed = parseRemote(url);
    } catch {
      parsed = null;
    }

    if (parsed === null) {
      unresolved.run(
        "No GitHub repository could be read from this project's folder. Re-link it to a repo to use it.",
        row.id,
      );
      continue;
    }
    resolved.run(parsed.owner, parsed.repo, row.id);
  }
}

backfillProjectIdentity();

export const nowIso = () => new Date().toISOString();

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  repo_path: string;
  base_branch: string;
  provision_state: string;
  provision_error: string;
  created_at: string;
  updated_at: string;
};

export type TicketRow = {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  finished: number;
  died: number;
  branch: string | null;
  agent_name: string | null;
  session_dir: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_additions: number | null;
  pr_deletions: number | null;
  playbook: string;
  priority: string;
  // Already parsed. The JSON lives in one TEXT column each, and the parse happens at the
  // decode boundary in ticket-store.ts, where a corrupt column can be reported by name.
  task_breakdown: ChecklistItem[];
  acceptance_criteria: ChecklistItem[];
  attachments: Attachment[];
  screenshot_before: string | null;
  screenshot_after: string | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
  archived: number;
};

/**
 * The provision-state parse boundary, mirroring `toStatus` below: SQLite hands back a bare
 * string, so exactly one place decides what it means. An unrecognised value decodes as
 * `failed` rather than `ready` — a row whose state cannot be read must never be treated as a
 * project with a working clone, because spawn would then try to create a worktree in a
 * directory that may not exist.
 */
export const toProvisionState = (raw: string): ProvisionState =>
  raw === "pending" || raw === "cloning" || raw === "ready" ? raw : "failed";

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  owner: r.owner,
  repo: r.repo,
  repoPath: r.repo_path,
  baseBranch: r.base_branch,
  provisionState: toProvisionState(r.provision_state),
  provisionError: r.provision_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * The status parse boundary: SQLite hands back a bare string, so exactly one place decides
 * what a row's status means. Every value the union knows must be listed here — a status
 * missing from it decodes as `backlog`, which would silently teleport a live ticket into the
 * wrong column rather than failing.
 */
export const toStatus = (raw: string): Status =>
  raw === "todo" || raw === "in_progress" || raw === "in_review" || raw === "done" ? raw : "backlog";

/**
 * Unlike toStatus, an unrecognised value decodes to null rather than a default: "we have
 * not heard about this PR" is a real and common state — most tickets never reach `done`,
 * let alone get their PR merged, so null must not read as any specific state.
 */
export const toPullRequestState = (raw: string | null): PullRequestState | null =>
  raw === "open" || raw === "merged" || raw === "closed" ? raw : null;

export const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  projectId: r.project_id,
  number: r.number,
  title: r.title,
  description: r.description,
  status: toStatus(r.status),
  finished: r.finished === 1,
  died: r.died === 1,
  archived: r.archived === 1,
  branch: r.branch,
  agentName: r.agent_name,
  sessionDir: r.session_dir,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  prState: toPullRequestState(r.pr_state),
  prAdditions: r.pr_additions,
  prDeletions: r.pr_deletions,
  // A cast, not a check, for the same reason `jsonList` in ticket-store.ts does not validate
  // the items it parses: only this API writes the column, and `updateTicket` tests every
  // incoming value against `PLAYBOOKS` before it goes in, so what comes back out is what we
  // put there. Unlike `toStatus`, which must decode a value Herdr-era rows could disagree
  // about, there is nothing here to decide. This is the seam to tighten if anything other
  // than this API ever gains write access to `tickets.playbook`.
  playbook: r.playbook as Playbook,
  // Same cast, same reasoning: only this API writes `tickets.priority`, and `updateTicket`
  // tests every incoming value against `PRIORITIES` before it goes in.
  priority: r.priority as Priority,
  taskBreakdown: r.task_breakdown,
  acceptanceCriteria: r.acceptance_criteria,
  attachments: r.attachments,
  // The two columns become the nested object here: `screenshots` is the shape the board
  // consumes, while a fixed pair of independently nullable paths is the shape SQLite wants.
  screenshots: { before: r.screenshot_before, after: r.screenshot_after },
  startedAt: r.started_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Atomic claim. Returns true only if this caller won the transition.
 *
 * The conditional WHERE is the lock: SQLite reports how many rows changed, so a second
 * request arriving concurrently matches nothing and loses. This replaces the in-process
 * check-then-assign and, unlike it, holds across processes.
 */
export function claimTicket(id: string, from: Status, to: Status): boolean {
  const res = db
    .prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, nowIso(), id, from);
  return res.changes === 1;
}

// ---------------------------------------------------------------------------
// Port slots. The pool arithmetic lives in ports.ts; this is only its persistence, and the
// UNIQUE index on `port_slot` is what makes a double assignment impossible.
// ---------------------------------------------------------------------------

const SLOT_OF = db.prepare("SELECT port_slot FROM tickets WHERE id = ?");
const HELD_SLOTS = db.prepare("SELECT port_slot FROM tickets WHERE port_slot IS NOT NULL");
const RESERVE_SLOT = db.prepare("UPDATE tickets SET port_slot = ?, updated_at = ? WHERE id = ?");
const RELEASE_SLOT = db.prepare(
  "UPDATE tickets SET port_slot = NULL, updated_at = ? WHERE id = ? AND port_slot IS NOT NULL",
);
/**
 * `in_review` is spared alongside `in_progress`: a ticket in review still OWNS its range,
 * because a Preview started there binds the same ports. The block is reserved for the
 * ticket's whole active life, not leased to whatever process happens to be running — so the
 * predicate names the statuses that hold a block rather than the one that has an agent.
 */
const RECLAIM_SLOTS = db.prepare(
  "UPDATE tickets SET port_slot = NULL, updated_at = ? " +
    "WHERE port_slot IS NOT NULL AND status NOT IN ('in_progress', 'in_review')",
);

// node:sqlite hands back dynamic column values, so every read of `port_slot` below narrows
// at its own use — this is the parse boundary.

/**
 * Reserve the lowest free block for a ticket, or report exhaustion.
 *
 * BEGIN IMMEDIATE for the same reason the ticket-number counter uses one: reading the held
 * set and writing the row that joins it must not be split by another writer, in this
 * process or in a second backend on the same file.
 *
 * Idempotent. A ticket that already holds a slot gets that one back, because handing it a
 * second would strand the first until the next boot.
 */
export function reservePortSlot(id: string): SlotAllocation {
  db.exec("BEGIN IMMEDIATE");
  try {
    const mine = SLOT_OF.get(id)?.["port_slot"];
    if (typeof mine === "number") {
      db.exec("COMMIT");
      return { ok: true, slot: mine };
    }
    const held = HELD_SLOTS.all().flatMap((row) => {
      const slot = row["port_slot"];
      return typeof slot === "number" ? [slot] : [];
    });
    const chosen = allocateSlot(held);
    if (chosen.ok) RESERVE_SLOT.run(chosen.slot, nowIso(), id);
    db.exec("COMMIT");
    return chosen;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Free a ticket's block. Unconditional and a no-op for a ticket holding none, so every
 * teardown path can call it from a `finally`: a slot leaked by a Herdr call that failed
 * halfway is gone until the next boot, and the pool is only ten wide.
 */
export function releasePortSlot(id: string): void {
  RELEASE_SLOT.run(nowIso(), id);
}

const SET_PULL_REQUEST = db.prepare(
  "UPDATE tickets SET pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?",
);

/**
 * Record the pull request opened for a ticket. Both columns are written together — a
 * ticket never has one without the other — so there is exactly one writer for this pair,
 * the same shape as `releasePortSlot` owning `port_slot`.
 */
export function setPullRequest(id: string, number: number, url: string): void {
  SET_PULL_REQUEST.run(number, url, nowIso(), id);
}

const SET_PULL_REQUEST_STATE = db.prepare(
  "UPDATE tickets SET pr_state = ?, pr_additions = ?, pr_deletions = ?, updated_at = ? WHERE pr_url = ?",
);

/**
 * Matched by PR URL, not number: PR numbers are per-repo and would collide across projects,
 * while the URL is globally unique and already stored. Returns false when no ticket owns that
 * PR — a webhook for somebody else's repo is normal, not an error.
 */
export function setPullRequestState(
  prUrl: string,
  state: PullRequestState,
  additions: number | null,
  deletions: number | null,
): boolean {
  const res = SET_PULL_REQUEST_STATE.run(state, additions, deletions, nowIso(), prUrl);
  return Number(res.changes) > 0;
}

const SET_SCREENSHOT: Record<ScreenshotSide, StatementSync> = {
  before: db.prepare("UPDATE tickets SET screenshot_before = ?, updated_at = ? WHERE id = ?"),
  after: db.prepare("UPDATE tickets SET screenshot_after = ?, updated_at = ? WHERE id = ?"),
};

/**
 * Point one side of the before/after pair at the route that serves it (screenshots.ts). Two
 * columns, not one JSON blob (see the schema comment above), so this writes exactly one and
 * leaves the other untouched — a ticket sits with a before and no after for its whole run.
 */
export function setScreenshot(id: string, side: ScreenshotSide, path: string): void {
  SET_SCREENSHOT[side].run(path, nowIso(), id);
}

/**
 * Boot-time reclaim of blocks held by tickets that are not in a port-holding state — the
 * residue of a process killed between reserving a slot and releasing it.
 *
 * This clears rows, which looks like a breach of the rule that reconciliation reports and
 * never destroys (memory/reconciliation.md). It is not. That rule protects the user's WORK:
 * a worktree, a branch, a transcript, none of which can be recreated. A port slot is our
 * own bookkeeping — a note saying "this number is spoken for" — so reclaiming one cannot
 * lose anything, while leaving them held silently shrinks the pool on every crash.
 *
 * `in_progress` and `in_review` are the port-holding statuses: the block is reserved at spawn
 * and released by every teardown path, a backlog ticket has no agent to be running a server,
 * and a ticket in review still owns its range for a Preview to bind.
 */
export function reclaimStalePortSlots(): number {
  return Number(RECLAIM_SLOTS.run(nowIso()).changes);
}
