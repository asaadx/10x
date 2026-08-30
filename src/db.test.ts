/**
 * Tests for `claimTicket`, the compare-and-swap that is the only lock in the system (§9).
 * A double-click, a double-drag or a retry must not start two spawns for one ticket.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-db-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts opens the database at module load, so DB_PATH must already be set: the one place
// a dynamic import is required rather than preferred. Static imports hoist above the
// assignments above and would open the real ~/.10x/10x.db.
const { claimTicket, db, nowIso } = await import("./db.ts");

// WAL leaves -wal and -shm siblings, so the whole temp directory goes, not just the file.
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = "proj";
db.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run(PROJECT_ID, "Test", "/tmp/repo", "main", nowIso(), nowIso());

const ANCIENT = "2020-01-01T00:00:00.000Z";
let nextNumber = 1;

/** Insert one ticket directly, bypassing every code path under test. */
function seed(id: string, status: string, updatedAt = ANCIENT): void {
  db.prepare(
    "INSERT INTO tickets (id, project_id, number, title, description, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, PROJECT_ID, nextNumber++, `ticket ${id}`, "", status, ANCIENT, updatedAt);
}

function readString(id: string, column: "status" | "updated_at"): string {
  const row = db.prepare(`SELECT ${column} AS value FROM tickets WHERE id = ?`).get(id);
  const value = row?.["value"];
  if (typeof value !== "string") assert.fail(`no string ${column} for ticket ${id}: ${value}`);
  return value;
}

describe("claimTicket", () => {
  test("a first claim from backlog to in_progress wins and moves the row", () => {
    seed("t-win", "backlog");
    assert.equal(claimTicket("t-win", "backlog", "in_progress"), true);
    assert.equal(readString("t-win", "status"), "in_progress");
  });

  // The whole reason the CAS exists: the second of two clicks must lose, not spawn a
  // second agent onto the same branch.
  test("an immediate identical second claim loses", () => {
    seed("t-double", "backlog");
    assert.equal(claimTicket("t-double", "backlog", "in_progress"), true);
    assert.equal(claimTicket("t-double", "backlog", "in_progress"), false);
    assert.equal(readString("t-double", "status"), "in_progress");
  });

  test("a claim whose `from` does not match the current status loses", () => {
    seed("t-mismatch", "in_progress");
    assert.equal(claimTicket("t-mismatch", "backlog", "in_progress"), false);
    assert.equal(readString("t-mismatch", "status"), "in_progress");
  });

  test("cancel is the same lock in reverse", () => {
    seed("t-cancel", "in_progress");
    assert.equal(claimTicket("t-cancel", "in_progress", "backlog"), true);
    assert.equal(claimTicket("t-cancel", "in_progress", "backlog"), false);
    assert.equal(readString("t-cancel", "status"), "backlog");
  });

  test("a claim on an unknown ticket id loses instead of throwing", () => {
    assert.equal(claimTicket("t-nonexistent", "backlog", "in_progress"), false);
  });

  test("a claim does not touch any other ticket", () => {
    seed("t-target", "backlog");
    seed("t-bystander", "backlog");
    assert.equal(claimTicket("t-target", "backlog", "in_progress"), true);
    assert.equal(readString("t-bystander", "status"), "backlog");
    assert.equal(readString("t-bystander", "updated_at"), ANCIENT);
  });

  test("a winning claim bumps updated_at; a losing one leaves it alone", () => {
    seed("t-stamp", "backlog");
    assert.equal(claimTicket("t-stamp", "backlog", "in_progress"), true);

    const bumped = readString("t-stamp", "updated_at");
    assert.ok(bumped > ANCIENT, `expected updated_at past ${ANCIENT}, got ${bumped}`);
    assert.equal(new Date(bumped).toISOString(), bumped, "updated_at must be an ISO instant");

    assert.equal(claimTicket("t-stamp", "backlog", "in_progress"), false);
    assert.equal(readString("t-stamp", "updated_at"), bumped);
  });
});
