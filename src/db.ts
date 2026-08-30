/**
 * SQLite store. Zero dependencies — `node:sqlite` is built into Node 24.
 *
 * Two design rules, both from memory/herdr-omp-lifecycle.md:
 *
 *  1. Store what WE own, never what Herdr owns (§6.2). `branch` and `agent_name` are
 *     values we choose and hand to Herdr, so they are persisted: if their format ever
 *     changes, existing tickets keep pointing at the branch that actually exists.
 *     Worktree paths, pane ids and workspace ids are Herdr's and are never stored —
 *     they are read live on every request.
 *
 *  2. Status is the lock (§9). `claimTicket` is a conditional UPDATE and reports whether
 *     it won, so a double-click cannot start two spawns.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  /** A turn ended after `working` was observed (§4.1). */
  finished: boolean;
  /** The pane exited. NOT the same as finished (§5.0 rule 3). */
  died: boolean;
  /** Persisted, not derived — see rule 1 above. Null until first spawn. */
  branch: string | null;
  agentName: string | null;
  /** OMP transcript directory, needed by teardown and outliving the worktree (§5.3). */
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
  -- not remove its worktree (§5.0), the new ticket's branch would collide with the orphan
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
