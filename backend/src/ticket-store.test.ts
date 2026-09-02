/**
 * Tests for `setRunFields`, the lifecycle writer used by spawn, teardown and reject to
 * flip `finished`/`died` without touching the fields a plain `updateTicket` owns.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-ticket-store-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts opens the database at module load, so DB_PATH must already be set — same reason
// db.test.ts uses a dynamic import.
const { db, nowIso } = await import("./db.ts");
const { setRunFields } = await import("./ticket-store.ts");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = "proj";
db.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run(PROJECT_ID, "Test", "/tmp/repo", "main", nowIso(), nowIso());

let nextNumber = 1;

function seed(id: string, finished: number, died: number): void {
  db.prepare(
    "INSERT INTO tickets (id, project_id, number, title, description, status, finished, died, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)",
  ).run(id, PROJECT_ID, nextNumber++, `ticket ${id}`, "", finished, died, nowIso(), nowIso());
}

function readFlags(id: string): { finished: number; died: number } {
  const row = db.prepare("SELECT finished, died FROM tickets WHERE id = ?").get(id) as
    | { finished: number; died: number }
    | undefined;
  if (!row) assert.fail(`no row for ticket ${id}`);
  return row;
}

describe("setRunFields", () => {
  test("clearing finished leaves died untouched", () => {
    seed("t-clear-finished", 1, 1);
    setRunFields("t-clear-finished", { finished: false });
    const flags = readFlags("t-clear-finished");
    assert.equal(flags.finished, 0);
    assert.equal(flags.died, 1);
  });

  test("an absent field is left alone entirely, not just re-written with its old value", () => {
    seed("t-absent", 1, 0);
    setRunFields("t-absent", { finished: false });
    const flags = readFlags("t-absent");
    assert.equal(flags.finished, 0);
    assert.equal(flags.died, 0);
  });
});
