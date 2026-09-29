/**
 * The store: schema, migrations, row types, and the small writers that each own a column.
 * Every query goes through the async `Sql` client in sql.ts — Turso when configured, a local
 * `node:sqlite` file otherwise — so nothing here knows which one it is talking to.
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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseRemote } from "./github.ts";
import { MAX_PORT_SLOTS, type SlotAllocation } from "./ports.ts";
import { openSql, type Sql, type Stmt } from "./sql.ts";
import {
  PLAYBOOKS,
  type AgentState,
  type Attachment,
  type ChecklistItem,
  type Playbook,
  type Priority,
  type Project,
  type ProvisionState,
  type PullRequestState,
  type ScreenshotSide,
  type SessionKind,
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

/**
 * One string per statement, not one multi-statement script: the `Sql` client runs exactly one
 * statement per call (Hrana has no "exec a script" request), so the schema is a batch.
 */
const SCHEMA = [
  `
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
  -- The shell command Preview runs in a ticket's checkout, with PORT set. '' means none:
  -- Preview still checks the branch out, it just starts nothing.
  dev_command TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)`,
  `
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
  -- The cloud session working this ticket (docs/prototype-cloud.md). The board writes the id,
  -- url and kind ('plan' | 'impl') when it starts one, and agent_state = 'starting'; from then
  -- on the AGENT writes agent_state, agent_note and agent_updated_at into this row itself, over
  -- Turso's HTTP API. Free text on disk, so each is narrowed at the decode boundary below.
  session_id       TEXT,
  session_url      TEXT,
  session_kind     TEXT,
  agent_state      TEXT,
  agent_note       TEXT,
  agent_updated_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, number)
)`,
  "CREATE INDEX IF NOT EXISTS tickets_by_project ON tickets (project_id, status)",
];

/**
 * The client. Constructing it touches nothing — the local driver opens its file on first use
 * and the Turso driver is only a URL — so importing this module is free, and a test can set
 * DB_PATH before its (dynamic) import. Nothing may query before `initDb()` has resolved.
 */
export const db: Sql = openSql(DB_PATH);

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an existing database untouched, so a column added
 * after the first release has to be migrated in. Table and column names are literals from
 * this file, never input. Idempotent: `PRAGMA table_info` decides.
 */
async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  if (rows.some((row) => row["name"] === column)) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function migrate(): Promise<void> {
  await db.batch(SCHEMA.map((sql) => ({ sql })));

  // A UNIQUE column constraint is impossible here: SQLite's ADD COLUMN rejects one. A unique
  // INDEX is the same thing by another name, and it is what a column constraint compiles to.
  await addColumnIfMissing("tickets", "port_slot", "INTEGER");
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS tickets_port_slot ON tickets (port_slot)");

  await addColumnIfMissing("tickets", "pr_number", "INTEGER");
  await addColumnIfMissing("tickets", "pr_url", "TEXT");
  await addColumnIfMissing("tickets", "pr_state", "TEXT");
  await addColumnIfMissing("tickets", "pr_additions", "INTEGER");
  await addColumnIfMissing("tickets", "pr_deletions", "INTEGER");

  // ADD COLUMN accepts NOT NULL only alongside a non-null constant default, which '[]' and
  // 'Fullstack' both are — and SQLite hands that default back for every row that predates the
  // column, so a migrated row reads as an empty list, or as the default playbook, never as NULL.
  await addColumnIfMissing("tickets", "playbook", "TEXT NOT NULL DEFAULT 'Fullstack'");
  await addColumnIfMissing("tickets", "task_breakdown", "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing("tickets", "acceptance_criteria", "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing("tickets", "attachments", "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing("tickets", "screenshot_before", "TEXT");
  await addColumnIfMissing("tickets", "screenshot_after", "TEXT");
  await addColumnIfMissing("tickets", "started_at", "TEXT");
  await addColumnIfMissing("tickets", "archived", "INTEGER NOT NULL DEFAULT 0");

  // Every pre-existing row backfills to 'low' on the same migration, no manual step: ADD
  // COLUMN with a NOT NULL constant default hands that default back for every row that
  // predates the column, exactly as the playbook and checklist columns above do.
  await addColumnIfMissing("tickets", "priority", "TEXT NOT NULL DEFAULT 'low'");

  // The cloud-session columns. All nullable: a ticket that never ran has no session.
  for (const column of [
    "session_id",
    "session_url",
    "session_kind",
    "agent_state",
    "agent_note",
    "agent_updated_at",
  ]) {
    await addColumnIfMissing("tickets", column, "TEXT");
  }

  // A database migrated while `playbook` was briefly nullable already has the column, so
  // `addColumnIfMissing` above will not revisit it and its NOT NULL default never applies to
  // those rows. One idempotent backfill covers them: without it, every such row's decode hits
  // a NULL in a column typed `Playbook` and throws.
  //
  // And a database written while this branch stored lowercase slugs ('fullstack', 'devops')
  // holds values the union no longer contains. Lowercasing a name yields exactly the slug it
  // replaced, so the remap is derived from `PLAYBOOKS` itself rather than hand-listed — there
  // is no second list to fall behind the first. Idempotent: a row already holding the exact
  // name matches itself and is rewritten to the same value.
  await db.batch([
    { sql: "UPDATE tickets SET playbook = 'Fullstack' WHERE playbook IS NULL" },
    ...PLAYBOOKS.map(
      (playbook): Stmt => ({
        sql: "UPDATE tickets SET playbook = ? WHERE lower(playbook) = lower(?)",
        args: [playbook, playbook],
      }),
    ),
  ]);

  // Projects gain the same treatment. 'ready' is the deliberate default for `provision_state`:
  // every project that predates this column was cloned by hand and is already usable, so the
  // migration must not park working projects in a provisioning state.
  await addColumnIfMissing("projects", "description", "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("projects", "owner", "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("projects", "repo", "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("projects", "provision_state", "TEXT NOT NULL DEFAULT 'ready'");
  await addColumnIfMissing("projects", "provision_error", "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("projects", "dev_command", "TEXT NOT NULL DEFAULT ''");

  await backfillProjectIdentity();
}

// A project's GitHub identity used to be re-derived from disk on every push and pull request.
// Backfilling it needs the one thing a migration cannot do inline — read a git remote — so
// this runs once, at init, and is idempotent: only rows still holding the empty default are
// touched, and a row that cannot be resolved is marked `failed` rather than left silently
// blank, because a project with no GitHub remote can never reach Done (docs/plug-and-play-projects.md).
async function backfillProjectIdentity(): Promise<void> {
  const { rows } = await db.execute("SELECT id, repo_path FROM projects WHERE owner = '' OR repo = ''");
  for (const row of rows) {
    const id = String(row["id"]);
    // A missing folder, a directory that is not a repo, a repo with no `origin`, and a
    // non-GitHub `origin` all land in the same bucket — unresolvable — so one catch covers the
    // lot. Synchronous git is fine here: it is boot-time, and only legacy rows ever get here.
    let parsed: { owner: string; repo: string } | null = null;
    try {
      const url = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: String(row["repo_path"]),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      parsed = parseRemote(url);
    } catch {
      parsed = null;
    }

    if (parsed === null) {
      await db.execute(
        "UPDATE projects SET provision_state = 'failed', provision_error = ? WHERE id = ?",
        ["No GitHub repository could be read from this project's folder. Re-link it to a repo to use it.", id],
      );
      continue;
    }
    await db.execute("UPDATE projects SET owner = ?, repo = ? WHERE id = ?", [parsed.owner, parsed.repo, id]);
  }
}

let ready: Promise<void> | undefined;

/**
 * Schema plus every migration. Idempotent, and memoised so any number of callers share one
 * run; a failed run is forgotten so the next call retries instead of replaying the rejection.
 *
 * Deliberately NOT an import side effect: `server.ts` awaits it before it listens, and every
 * test that touches the store awaits it first. Against Turso this is a dozen network round
 * trips, which a module import must never hide.
 */
export function initDb(): Promise<void> {
  ready ??= migrate().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

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
  dev_command: string;
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
  session_id: string | null;
  session_url: string | null;
  session_kind: string | null;
  agent_state: string | null;
  agent_note: string | null;
  agent_updated_at: string | null;
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

/**
 * The one definition of "10x made this clone". A project created under the plug-and-play flow
 * always has `repo_path = $PROJECTS_ROOT/<id>`; one that predates it keeps whatever folder the
 * user originally pointed 10x at, which the migration deliberately does not move. Only the
 * former may be deleted, and only the former may be *described* as deletable.
 */
export const ownsClone = (repoPath: string): boolean =>
  dirname(resolve(repoPath)) === resolve(PROJECTS_ROOT);

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
  ownsClone: ownsClone(r.repo_path),
  devCommand: r.dev_command,
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

/**
 * A REAL parse, not a cast: unlike every other column here, `agent_state` is written by the
 * agent over HTTP (docs/prototype-cloud.md), not by this API, so it can hold anything. An
 * unrecognised value reads as null — "no usable report" — never as some specific state that
 * could, say, trigger the done → in_review move.
 */
export const toAgentState = (raw: string | null): AgentState | null =>
  raw === "starting" || raw === "working" || raw === "done" || raw === "blocked" || raw === "failed"
    ? raw
    : null;

/** Board-written, but narrowed the same way so the two session columns share one posture. */
export const toSessionKind = (raw: string | null): SessionKind | null =>
  raw === "plan" || raw === "impl" ? raw : null;

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
  sessionId: r.session_id,
  sessionUrl: r.session_url,
  sessionKind: toSessionKind(r.session_kind),
  agentState: toAgentState(r.agent_state),
  agentNote: r.agent_note,
  agentUpdatedAt: r.agent_updated_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Atomic claim. Resolves true only if this caller won the transition.
 *
 * The conditional WHERE is the lock: the database reports how many rows changed, so a second
 * request arriving concurrently matches nothing and loses. It holds across processes — and,
 * against Turso, across machines — because the check and the write are one statement.
 */
export async function claimTicket(id: string, from: Status, to: Status): Promise<boolean> {
  const res = await db.execute(
    "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
    [to, nowIso(), id, from],
  );
  return res.rowsAffected === 1;
}

// ---------------------------------------------------------------------------
// Port slots. The pool arithmetic lives in ports.ts; this is only its persistence, and the
// UNIQUE index on `port_slot` is what makes a double assignment impossible.
// ---------------------------------------------------------------------------

/**
 * The lowest slot in [0, cap) no ticket holds, or NULL when the pool is exhausted — the same
 * answer `allocateSlot` gives, computed inside the database so the read of the held set and
 * the write that joins it are ONE statement. That is what a `BEGIN IMMEDIATE` around a JS
 * read-then-write used to buy, and over HTTP there is no connection to hold it on.
 */
const FREE_SLOT = `(
  WITH RECURSIVE pool(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM pool WHERE n + 1 < ?)
  SELECT MIN(n) FROM pool WHERE n NOT IN (SELECT port_slot FROM tickets WHERE port_slot IS NOT NULL)
)`;

/**
 * Reserve the lowest free block for a ticket, or report exhaustion.
 *
 * Idempotent. A ticket that already holds a slot gets that one back (`port_slot IS NULL`
 * gates the write), because handing it a second would strand the first until the next boot.
 * An exhausted pool writes nothing — not even `updated_at` — and reads back NULL.
 */
export async function reservePortSlot(id: string, cap = MAX_PORT_SLOTS): Promise<SlotAllocation> {
  const [, read] = await db.batch([
    {
      sql:
        `UPDATE tickets SET port_slot = ${FREE_SLOT}, updated_at = ? ` +
        `WHERE id = ? AND port_slot IS NULL AND ${FREE_SLOT} IS NOT NULL`,
      args: [cap, nowIso(), id, cap],
    },
    { sql: "SELECT port_slot FROM tickets WHERE id = ?", args: [id] },
  ]);
  const slot = read?.rows[0]?.["port_slot"];
  return typeof slot === "number" ? { ok: true, slot } : { ok: false, reason: "pool_exhausted", cap };
}

/**
 * Free a ticket's block. Unconditional and a no-op for a ticket holding none, so every
 * teardown path can call it from a `finally`: a slot leaked by a Herdr call that failed
 * halfway is gone until the next boot, and the pool is only ten wide.
 */
export async function releasePortSlot(id: string): Promise<void> {
  await db.execute(
    "UPDATE tickets SET port_slot = NULL, updated_at = ? WHERE id = ? AND port_slot IS NOT NULL",
    [nowIso(), id],
  );
}

/**
 * Record the pull request opened for a ticket. Both columns are written together — a
 * ticket never has one without the other — so there is exactly one writer for this pair,
 * the same shape as `releasePortSlot` owning `port_slot`.
 */
export async function setPullRequest(id: string, number: number, url: string): Promise<void> {
  await db.execute("UPDATE tickets SET pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?", [
    number,
    url,
    nowIso(),
    id,
  ]);
}

/**
 * Matched by PR URL, not number: PR numbers are per-repo and would collide across projects,
 * while the URL is globally unique and already stored. Resolves false when no ticket owns that
 * PR — a webhook for somebody else's repo is normal, not an error.
 */
export async function setPullRequestState(
  prUrl: string,
  state: PullRequestState,
  additions: number | null,
  deletions: number | null,
): Promise<boolean> {
  const res = await db.execute(
    "UPDATE tickets SET pr_state = ?, pr_additions = ?, pr_deletions = ?, updated_at = ? WHERE pr_url = ?",
    [state, additions, deletions, nowIso(), prUrl],
  );
  return res.rowsAffected > 0;
}

const SCREENSHOT_COLUMN: Record<ScreenshotSide, string> = {
  before: "screenshot_before",
  after: "screenshot_after",
};

/**
 * Point one side of the before/after pair at the route that serves it (screenshots.ts). Two
 * columns, not one JSON blob (see the schema comment above), so this writes exactly one and
 * leaves the other untouched — a ticket sits with a before and no after for its whole run.
 */
export async function setScreenshot(id: string, side: ScreenshotSide, path: string): Promise<void> {
  await db.execute(`UPDATE tickets SET ${SCREENSHOT_COLUMN[side]} = ?, updated_at = ? WHERE id = ?`, [
    path,
    nowIso(),
    id,
  ]);
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
 * and a ticket in review still owns its range for a Preview to bind — the block is reserved
 * for the ticket's whole active life, not leased to whatever process happens to be running.
 */
export async function reclaimStalePortSlots(): Promise<number> {
  const res = await db.execute(
    "UPDATE tickets SET port_slot = NULL, updated_at = ? " +
      "WHERE port_slot IS NOT NULL AND status NOT IN ('in_progress', 'in_review')",
    [nowIso()],
  );
  return res.rowsAffected;
}
