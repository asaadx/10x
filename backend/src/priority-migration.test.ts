/**
 * Regression coverage for the `priority` migration: a database written before this column
 * existed must read every existing ticket back as `priority: "low"` once the server's normal
 * startup migration runs against it, with no manual step. Mirrors the same `addColumnIfMissing`
 * guarantee the other backfilled columns (`playbook`, `archived`, ...) rely on, but this is the
 * one place that proof is actually exercised end to end rather than assumed.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-priority-migration-test-"));
const dbPath = join(dir, "10x.db");

// The schema as it looked before this column existed: no `priority`, and none of the other
// columns added after the first release either, since a real pre-priority database predates
// those too. `db.ts`'s own `CREATE TABLE IF NOT EXISTS` is a no-op once the table already
// exists, so only its `addColumnIfMissing` calls get a chance to backfill this row.
const pre = new DatabaseSync(dbPath);
pre.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    finished INTEGER NOT NULL DEFAULT 0,
    died INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    agent_name TEXT,
    session_dir TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, number)
  );
`);
const now = new Date().toISOString();
pre.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run("proj", "Test", "/tmp/repo", "main", now, now);
pre.prepare(
  "INSERT INTO tickets (id, project_id, number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run("proj-1", "proj", 1, "Pre-existing ticket", now, now);
pre.close();

process.env.STATE_DIR = dir;
process.env.DB_PATH = dbPath;

// db.ts opens the database and runs every migration at module load time, so DB_PATH must
// already point at the pre-existing file above before it is ever imported — a static import
// hoists above the assignments and would migrate the real ~/.10x/10x.db instead. Same reason
// db.test.ts and ticket-store.test.ts both use a dynamic import here.
const { db, initDb } = await import("./db.ts");
await initDb();
const { getTicket } = await import("./ticket-store.ts");

after(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe("priority migration", () => {
  test("a ticket row that predates the priority column reads back as low with no manual step", async () => {
    const ticket = await getTicket("proj-1");
    assert.ok(ticket, "ticket vanished across the migration");
    assert.equal(ticket.priority, "low");
  });
});
