/**
 * Tests for screenshot storage: the write path a ticket's own agent uploads through, and the
 * delete path that reclaims files when the ticket does (memory/architecture.md, port pool —
 * the same "our own bookkeeping" treatment).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "10x-screenshots-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");

// db.ts opens the database at module load, so DB_PATH must already be set — the one dynamic
// import this file needs, same reason port-slots.test.ts has one.
const { db, nowIso } = await import("./db.ts");
const { deleteScreenshots, saveScreenshot, screenshotFile, SCREENSHOTS_DIR } =
  await import("./screenshots.ts");
const { getTicket } = await import("./ticket-store.ts");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = "proj";
db.prepare(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run(PROJECT_ID, "Test", "/tmp/repo", "main", nowIso(), nowIso());

let nextNumber = 1;
function seedTicket(): string {
  const number = nextNumber++;
  const id = `${PROJECT_ID}-${number}`;
  db.prepare(
    `INSERT INTO tickets (id, project_id, number, title, description, status,
                          finished, died, branch, agent_name, session_dir, created_at, updated_at)
     VALUES (?, ?, ?, 'Ticket', '', 'in_progress', 0, 0, NULL, NULL, NULL, ?, ?)`,
  ).run(id, PROJECT_ID, number, nowIso(), nowIso());
  return id;
}

describe("saveScreenshot", () => {
  test("writes the bytes under STATE_DIR/screenshots and points the ticket's column at the served path", async () => {
    const id = seedTicket();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // a PNG magic number is enough

    const path = await saveScreenshot(id, "before", bytes);

    assert.equal(path, `/screenshots/${id}-before.png`);
    assert.deepEqual(await readFile(screenshotFile(id, "before")), bytes);
    assert.equal(screenshotFile(id, "before"), join(SCREENSHOTS_DIR, `${id}-before.png`));
    assert.deepEqual(getTicket(id)?.screenshots, { before: path, after: null });
  });

  test("before and after are independent: writing one leaves the other null", async () => {
    const id = seedTicket();
    await saveScreenshot(id, "after", Buffer.from("after"));
    assert.deepEqual(getTicket(id)?.screenshots, { before: null, after: `/screenshots/${id}-after.png` });
  });

  test("a second upload for the same side overwrites the file rather than accumulating one", async () => {
    const id = seedTicket();
    await saveScreenshot(id, "before", Buffer.from("first"));
    await saveScreenshot(id, "before", Buffer.from("second"));
    assert.deepEqual(await readFile(screenshotFile(id, "before")), Buffer.from("second"));
  });
});

describe("deleteScreenshots", () => {
  test("removes both files, leaving the ticket's own row untouched", async () => {
    const id = seedTicket();
    await saveScreenshot(id, "before", Buffer.from("b"));
    await saveScreenshot(id, "after", Buffer.from("a"));

    await deleteScreenshots(id);

    assert.equal(existsSync(screenshotFile(id, "before")), false);
    assert.equal(existsSync(screenshotFile(id, "after")), false);
    // The column values are stale paths at this point — deleteScreenshots is a file
    // operation, not a row write; the caller deletes the row itself (server.ts).
    assert.equal(getTicket(id) !== undefined, true);
  });

  test("a ticket that never captured anything deletes without error", async () => {
    const id = seedTicket();
    await assert.doesNotReject(deleteScreenshots(id));
  });
});
