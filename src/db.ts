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
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { allocateSlot, type SlotAllocation } from "./ports.ts";

export const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), ".10x");
const DB_PATH = process.env.DB_PATH ?? join(STATE_DIR, "10x.db");

export type Status = "backlog" | "in_progress";

export type Project = {
  /** Immutable slug used in branch and agent names. Renaming would orphan worktrees. */
  id: string;
  /** Display name. Freely renameable — nothing derived depends on it. */
  name: string;
  repoPath: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type Ticket = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  /** A turn ended after `working` was observed (memory/agent-status.md). */
  finished: boolean;
  /** The pane exited. NOT the same as finished (memory/teardown.md rule 3). */
  died: boolean;
  /** Persisted, not derived — see rule 1 above. Null until first spawn. */
  branch: string | null;
  agentName: string | null;
  /** OMP transcript directory, needed by teardown and outliving the worktree (memory/reconciliation.md). */
  sessionDir: string | null;
  createdAt: string;
  updatedAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  repo_path   TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
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
  -- ports.ts. Nullable: a ticket holds one only while it is in progress. Persisted because
  -- a restart that forgot the held slots would hand one slot to two tickets.
  --
  -- The uniqueness (a UNIQUE INDEX, created below) IS the safety: SQLite makes
  -- double-assignment impossible, the same way the conditional UPDATE in claimTicket
  -- makes a double spawn impossible. NULLs are distinct in SQLite, so any number of
  -- tickets may hold no slot at all.
  port_slot   INTEGER,
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

export const nowIso = () => new Date().toISOString();

type ProjectRow = {
  id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  created_at: string;
  updated_at: string;
};

type TicketRow = {
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
  created_at: string;
  updated_at: string;
};

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  repoPath: r.repo_path,
  baseBranch: r.base_branch,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  projectId: r.project_id,
  number: r.number,
  title: r.title,
  description: r.description,
  status: r.status === "in_progress" ? "in_progress" : "backlog",
  finished: r.finished === 1,
  died: r.died === 1,
  branch: r.branch,
  agentName: r.agent_name,
  sessionDir: r.session_dir,
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
const RECLAIM_SLOTS = db.prepare(
  "UPDATE tickets SET port_slot = NULL, updated_at = ? WHERE port_slot IS NOT NULL AND status <> 'in_progress'",
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
 * `in_progress` is the only status that holds a block: it is reserved at spawn and released
 * by every teardown path, and a backlog ticket has no agent to be running a server.
 */
export function reclaimStalePortSlots(): number {
  return Number(RECLAIM_SLOTS.run(nowIso()).changes);
}
