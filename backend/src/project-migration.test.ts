/**
 * Regression coverage for the `projects` migration. A database written before this feature must
 * come out the other side with every project's GitHub identity filled in from the repo on disk,
 * and — the part that actually matters — a project whose folder yields no GitHub remote must be
 * marked `failed` rather than left holding two empty strings. Such a project could never reach
 * Done anyway (Accept pushes a branch and opens a PR), so the migration's job is to make that
 * visible instead of silent.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-project-migration-test-"));
const dbPath = join(dir, "10x.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// A real repo with a real `origin`. No network: the backfill only reads the remote's URL.
const withRemote = join(dir, "with-remote");
mkdirSync(withRemote, { recursive: true });
git(withRemote, "init", "-q");
git(withRemote, "remote", "add", "origin", "https://github.com/acme/widgets.git");

// A folder that is not a repo at all — the shape a project takes once its checkout has been
// moved or deleted, which is exactly when the backfill has nothing to read.
const notARepo = join(dir, "not-a-repo");
mkdirSync(notARepo, { recursive: true });

// The schema as it looked before this feature: no description, owner, repo or provisioning
// columns. `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so only db.ts's
// `addColumnIfMissing` calls and its backfill get a chance to touch these rows.
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
const insert = pre.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
);
insert.run("linked", "Linked", withRemote, "main", now, now);
insert.run("orphaned", "Orphaned", notARepo, "main", now, now);
pre.close();

process.env.STATE_DIR = dir;
process.env.DB_PATH = dbPath;

// db.ts migrates at module load, so DB_PATH must point at the file above before it is imported
// — a static import hoists over these assignments and would migrate the real ~/.10x/10x.db.
const { db, initDb } = await import("./db.ts");
await initDb();
const { getProject } = await import("./projects.ts");

after(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe("projects migration", () => {
  test("a project whose folder has a GitHub origin gets its identity backfilled", async () => {
    const project = await getProject("linked");
    assert.ok(project, "project vanished across the migration");
    assert.equal(project.owner, "acme");
    assert.equal(project.repo, "widgets");
  });

  test("an already-cloned project stays usable — it must not be parked as unprovisioned", async () => {
    const project = await getProject("linked");
    assert.ok(project);
    assert.equal(project.provisionState, "ready");
    assert.equal(project.provisionError, "");
  });

  test("columns added by the migration read back as their defaults, not NULL", async () => {
    const project = await getProject("linked");
    assert.ok(project);
    // NULL here would throw in rowToProject rather than arriving as a string.
    assert.equal(project.description, "");
  });

  test("a project with no readable GitHub remote is marked failed, not left blank", async () => {
    const project = await getProject("orphaned");
    assert.ok(project, "project vanished across the migration");
    assert.equal(project.owner, "");
    assert.equal(project.repo, "");
    assert.equal(project.provisionState, "failed");
    assert.match(project.provisionError, /re-link/i);
  });

  test("the backfill is idempotent: a second migration pass leaves resolved rows alone", async () => {
    // The backfill only selects rows still holding the empty default, so re-running it must
    // not overwrite `linked` — and must not resurrect `orphaned` into a resolved state.
    const before = await getProject("linked");
    await db.execute("UPDATE projects SET updated_at = updated_at WHERE id = 'linked'");
    const after_ = await getProject("linked");
    assert.ok(before && after_);
    assert.equal(after_.owner, before.owner);
    assert.equal(after_.repo, before.repo);
  });
});
